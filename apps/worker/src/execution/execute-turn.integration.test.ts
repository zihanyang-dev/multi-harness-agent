import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { HarnessRun, HarnessSession, HarnessTurnResult } from '@multi-harness/harness';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../tests/integration/database.js';
import { requestCancellation } from '../../../server/src/db/cancellations.js';
import { acceptTurn } from '../../../server/src/db/submissions.js';
import { createThread } from '../../../server/src/db/threads.js';
import type { PiTurnHost } from '../contract.js';
import { markReconciliation } from './db/turns.js';
import { executeTurn } from './execute-turn.js';

const binding = {
  harness: 'pi',
  sdkVersion: '1.1.0',
  provider: 'faux',
  model: 'faux',
  policy: 'text-v1',
  storageId: 'test-volume',
} as const;
let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
beforeEach(async () => {
  fixture = await createTestDatabase();
});
afterEach(async () => {
  await fixture.dispose();
});

async function accepted() {
  const thread = await createThread(fixture.database, { ownerId: 'alice', binding });
  const reply = await acceptTurn(fixture.database, {
    ownerId: 'alice',
    threadId: thread.id,
    requestId: randomUUID(),
    input: { content: [{ type: 'text', text: 'Hello' }] },
  });
  if (reply.kind !== 'accepted') throw new Error('Expected accepted fixture');
  return { threadId: thread.id, turnId: reply.turn.id };
}
function controlled() {
  const opened = Promise.withResolvers<void>();
  const invoked = Promise.withResolvers<void>();
  const interrupted = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const cleaning = Promise.withResolvers<void>();
  const receipt = Promise.withResolvers<HarnessTurnResult>();
  const nativeSessionId = randomUUID();
  let invocations = 0;
  let opens = 0;
  let interruptions = 0;
  const run: HarnessRun = {
    events: {
      [Symbol.asyncIterator]() {
        throw new Error('Events must not be consumed');
      },
    },
    result: receipt.promise,
    interrupt: async () => {
      interruptions++;
      interrupted.resolve();
    },
  };
  const session: HarnessSession = {
    nativeSessionId,
    run: async () => {
      invocations++;
      invoked.resolve();
      return run;
    },
    dispose: async () => {
      cleaning.resolve();
      await cleanup.promise;
    },
  };
  const host: PiTurnHost = {
    binding,
    openSession: async () => {
      opens++;
      opened.resolve();
      return session;
    },
  };
  return {
    host,
    session,
    receipt,
    opened,
    invoked,
    interrupted,
    cleanup,
    cleaning,
    nativeSessionId,
    invocations: () => invocations,
    interruptions: () => interruptions,
    opens: () => opens,
  };
}
const completed: HarnessTurnResult = {
  status: 'completed',
  messages: [{ id: 'answer', role: 'assistant', content: 'Done' }],
};
function execute(
  turnId: string,
  host: PiTurnHost,
  signal = new AbortController().signal,
  maxRunMs = 5_000,
) {
  return executeTurn(fixture.database, { turnId, host, signal, maxRunMs });
}
async function row(turnId: string) {
  return fixture.database
    .selectFrom('turns')
    .selectAll()
    .where('id', '=', turnId)
    .executeTakeFirstOrThrow();
}

it('joins transferred cleanup before public text commit and makes duplicate delivery a no-op', async () => {
  const { turnId } = await accepted();
  const c = controlled();
  const executing = execute(turnId, c.host);
  await c.invoked.promise;
  await execute(turnId, c.host);
  expect(c.invocations()).toBe(1);
  c.receipt.resolve({
    status: 'completed',
    messages: [
      {
        id: 'answer',
        role: 'assistant',
        content: 'Done',
        toolCalls: [
          { id: 'private', type: 'function', function: { name: 'secret', arguments: 'secret' } },
        ],
      },
      { id: 'tool', role: 'tool', content: 'Private', toolCallId: 'private' },
    ],
  });
  await c.cleaning.promise;
  expect((await row(turnId)).status).toBe('running');
  expect((await row(turnId)).result_json).toBeNull();
  c.cleanup.resolve();
  await executing;
  expect((await row(turnId)).result_json).toEqual({
    messages: [{ id: 'answer', role: 'assistant', content: 'Done' }],
  });
  expect((await row(turnId)).status).toBe('completed');
  await execute(turnId, c.host);
  expect(c.opens()).toBe(1);
});

it('leaves preclaim shutdown-aborted work accepted and rediscoverable', async () => {
  const { turnId } = await accepted();
  const c = controlled();
  const controller = new AbortController();
  controller.abort();
  await execute(turnId, c.host, controller.signal);
  expect((await row(turnId)).status).toBe('accepted');
  expect(c.opens()).toBe(0);
  expect(await fixture.database.selectFrom('turn_attempts').selectAll().execute()).toEqual([]);
});

it('blocks admission on rejected cleanup and never retakes unknown execution', async () => {
  const { turnId } = await accepted();
  const c = controlled();
  const executing = execute(turnId, c.host);
  await c.invoked.promise;
  c.receipt.resolve(completed);
  await c.cleaning.promise;
  c.cleanup.reject(new Error('private cleanup input'));
  await executing;
  expect((await row(turnId)).failure_code).toBe('cleanup_failed');
  expect((await row(turnId)).status).toBe('needs_reconciliation');
  await execute(turnId, c.host);
  expect(c.invocations()).toBe(1);
  expect(
    (await fixture.database.selectFrom('turn_attempts').selectAll().executeTakeFirstOrThrow())
      .stopped_at,
  ).toBeNull();
});

it('redacts native in-band failure after successful cleanup', async () => {
  const { turnId } = await accepted();
  const c = controlled();
  const executing = execute(turnId, c.host);
  await c.invoked.promise;
  c.receipt.reject(
    new Error('private provider response', {
      cause: { role: 'assistant', stopReason: 'error', errorMessage: 'private input' },
    }),
  );
  c.cleanup.resolve();
  await executing;
  expect((await row(turnId)).status).toBe('failed');
  expect((await row(turnId)).failure_code).toBe('execution_failed');
  expect((await row(turnId)).result_json).toBeNull();
});

it('does not advance thread history when cancelled after allocation before invocation', async () => {
  const { turnId, threadId } = await accepted();
  const c = controlled();
  const host: PiTurnHost = {
    binding,
    openSession: async () => {
      await requestCancellation(fixture.database, { ownerId: 'alice', turnId });
      return c.session;
    },
  };
  c.cleanup.resolve();
  await execute(turnId, host);
  expect(c.invocations()).toBe(0);
  expect((await row(turnId)).status).toBe('cancelled');
  expect(
    (
      await fixture.database
        .selectFrom('threads')
        .selectAll()
        .where('id', '=', threadId)
        .executeTakeFirstOrThrow()
    ).native_session_id,
  ).toBeNull();
  expect(
    (await fixture.database.selectFrom('turn_attempts').selectAll().executeTakeFirstOrThrow())
      .native_session_id,
  ).toBe(c.nativeSessionId);
});

it.each(['persistent', 'shutdown', 'deadline'] as const)(
  'requests %s interruption but waits for actual outcome and cleanup',
  async (control) => {
    const { turnId } = await accepted();
    const c = controlled();
    const controller = new AbortController();
    const executing = execute(
      turnId,
      c.host,
      controller.signal,
      control === 'deadline' ? 40 : 5_000,
    );
    await c.invoked.promise;
    if (control === 'persistent')
      await requestCancellation(fixture.database, { ownerId: 'alice', turnId });
    if (control === 'shutdown') controller.abort();
    await c.interrupted.promise;
    expect((await row(turnId)).status).toBe('running');
    c.receipt.resolve({ status: 'cancelled', messages: [] });
    c.cleanup.resolve();
    await executing;
    expect((await row(turnId)).status).toBe('cancelled');
  },
);

it('allows completion to win a cancellation race', async () => {
  const { turnId } = await accepted();
  const c = controlled();
  const controller = new AbortController();
  const executing = execute(turnId, c.host, controller.signal);
  await c.invoked.promise;
  controller.abort();
  await c.interrupted.promise;
  c.receipt.resolve(completed);
  c.cleanup.resolve();
  await executing;
  expect((await row(turnId)).status).toBe('completed');
});

it.each(['paused', 'reader-fault'] as const)(
  'fails closed for %s instead of committing a terminal result',
  async (kind) => {
    const { turnId } = await accepted();
    const c = controlled();
    const executing = execute(turnId, c.host);
    await c.invoked.promise;
    if (kind === 'paused') c.receipt.resolve({ status: 'paused', messages: [] });
    else c.receipt.reject(new Error('private reader failure'));
    c.cleanup.resolve();
    await executing;
    expect((await row(turnId)).status).toBe('needs_reconciliation');
    expect((await row(turnId)).failure_code).toBe(
      kind === 'paused' ? 'unsupported_pause' : 'execution_unknown',
    );
  },
);

it('cannot commit after a concurrent owner fence change during cleanup', async () => {
  const { turnId } = await accepted();
  const c = controlled();
  const executing = execute(turnId, c.host);
  await c.invoked.promise;
  c.receipt.resolve(completed);
  await c.cleaning.promise;
  const attempt = await fixture.database
    .selectFrom('turn_attempts')
    .selectAll()
    .executeTakeFirstOrThrow();
  await markReconciliation(fixture.database, {
    turnId,
    attemptId: attempt.id,
    code: 'execution_unknown',
  });
  c.cleanup.resolve();
  await expect(executing).rejects.toThrow('result_commit_unknown');
  expect((await row(turnId)).status).toBe('needs_reconciliation');
  expect((await row(turnId)).result_json).toBeNull();
});

it('interrupts and joins after a persistent-control database failure without inventing a stopped outcome', async () => {
  const { turnId } = await accepted();
  const c = controlled();
  const executing = execute(turnId, c.host);
  await c.invoked.promise;
  await fixture.pool.query('alter table turn_attempts rename to unavailable_attempts');
  await c.interrupted.promise;
  expect((await row(turnId)).status).toBe('running');
  await fixture.pool.query('alter table unavailable_attempts rename to turn_attempts');
  c.receipt.resolve(completed);
  c.cleanup.resolve();
  await executing;
  expect((await row(turnId)).status).toBe('needs_reconciliation');
  expect((await row(turnId)).failure_code).toBe('execution_unknown');
  expect(
    (await fixture.database.selectFrom('turn_attempts').selectAll().executeTakeFirstOrThrow())
      .stopped_at,
  ).toBeNull();
});

it('keeps a failed formal result transaction fenced and marked for reconciliation', async () => {
  const { turnId } = await accepted();
  const c = controlled();
  await fixture.pool.query(`create function reject_result() returns trigger language plpgsql as $$ begin
    if new.status = 'completed' then raise exception 'private commit fault'; end if; return new; end $$;
    create trigger reject_result before update on turns for each row execute function reject_result()`);
  const executing = execute(turnId, c.host);
  await c.invoked.promise;
  c.receipt.resolve(completed);
  c.cleanup.resolve();
  await expect(executing).rejects.toThrow('result_commit_unknown');
  expect((await row(turnId)).status).toBe('needs_reconciliation');
  expect((await row(turnId)).failure_code).toBe('result_commit_unknown');
  expect((await row(turnId)).result_json).toBeNull();
});

it('joins the polling timer on completion rather than interrupting a later idle session', async () => {
  const { turnId } = await accepted();
  const c = controlled();
  const executing = execute(turnId, c.host, new AbortController().signal, 100);
  await c.invoked.promise;
  c.receipt.resolve(completed);
  c.cleanup.resolve();
  await executing;
  await delay(150);
  expect(c.interruptions()).toBe(0);
  expect((await row(turnId)).status).toBe('completed');
});

it('advances exact native history only after an invoked conversation settles', async () => {
  const { turnId, threadId } = await accepted();
  const first = controlled();
  const executing = execute(turnId, first.host);
  await first.invoked.promise;
  first.receipt.resolve(completed);
  first.cleanup.resolve();
  await executing;
  const second = await acceptTurn(fixture.database, {
    ownerId: 'alice',
    threadId,
    requestId: randomUUID(),
    input: { content: [{ type: 'text', text: 'Continue' }] },
  });
  if (second.kind !== 'accepted') throw new Error('Expected accepted fixture');
  let reopened: string | undefined;
  const next = controlled();
  const host: PiTurnHost = {
    binding,
    openSession: async (request) => {
      reopened = request.nativeSessionId;
      return { ...next.session, nativeSessionId: first.nativeSessionId };
    },
  };
  const continuing = execute(second.turn.id, host);
  await next.invoked.promise;
  next.receipt.resolve(completed);
  next.cleanup.resolve();
  await continuing;
  expect(reopened).toBe(first.nativeSessionId);
  expect((await row(second.turn.id)).status).toBe('completed');
});

it('quarantines corrupt persisted input without claiming or allocating native resources', async () => {
  const { turnId, threadId } = await accepted();
  await fixture.pool.query('update turns set input_json = $1::jsonb where id = $2', [
    JSON.stringify({ content: [{ type: 'image', secret: 'private-corrupt-input' }] }),
    turnId,
  ]);
  const c = controlled();
  c.receipt.resolve(completed);
  c.cleanup.resolve();

  await execute(turnId, c.host);
  expect((await row(turnId)).status).toBe('needs_reconciliation');
  expect((await row(turnId)).failure_code).toBe('invalid_input');
  expect(
    await acceptTurn(fixture.database, {
      ownerId: 'alice',
      threadId,
      requestId: randomUUID(),
      input: { content: [{ type: 'text', text: 'Must remain blocked' }] },
    }),
  ).toEqual({ kind: 'conflict', reason: 'thread_busy' });
  await execute(turnId, c.host);
  expect(c.opens()).toBe(0);
  expect(c.invocations()).toBe(0);
  expect(await fixture.database.selectFrom('turn_attempts').selectAll().execute()).toEqual([]);
});
