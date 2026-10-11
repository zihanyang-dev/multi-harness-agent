import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { requestCancellation } from '../../apps/server/src/db/cancellations.js';
import { getTurn } from '../../apps/server/src/db/conversation-history.js';
import { acceptTurn } from '../../apps/server/src/db/submissions.js';
import { createThread, getThread } from '../../apps/server/src/db/threads.js';
import {
  claimTurn,
  finishTurn,
  isCancellationRequested,
  markReconciliation,
} from '../../apps/worker/src/execution/db/turns.js';
import { createTestDatabase } from './database.js';

const binding = {
  harness: 'pi',
  sdkVersion: '1.1.0',
  provider: 'faux',
  model: 'faux',
  policy: 'text-v1',
  storageId: 'test-volume',
} as const;
const input = {
  content: [
    { type: 'text' as const, text: 'First ' },
    { type: 'text' as const, text: 'second' },
  ],
};
let fixture: Awaited<ReturnType<typeof createTestDatabase>>;

beforeEach(async () => {
  fixture = await createTestDatabase();
});
afterEach(async () => {
  await fixture?.dispose();
});

it('commits immutable accepted input and its outbox notification together', async () => {
  const thread = await createThread(fixture.database, { ownerId: 'alice', binding });
  const accepted = await acceptTurn(fixture.database, {
    ownerId: 'alice',
    threadId: thread.id,
    requestId: randomUUID(),
    input,
  });
  expect(accepted.kind).toBe('accepted');
  expect(await fixture.database.selectFrom('turns').selectAll().execute()).toHaveLength(1);
  expect(await fixture.database.selectFrom('turn_outbox').selectAll().execute()).toHaveLength(1);
});

it('serializes concurrent same-key retries to one canonical turn', async () => {
  const thread = await createThread(fixture.database, { ownerId: 'alice', binding });
  const request = { ownerId: 'alice', threadId: thread.id, requestId: randomUUID(), input };
  const replies = await Promise.all(
    Array.from({ length: 8 }, () => acceptTurn(fixture.database, request)),
  );
  expect(replies.every((reply) => reply.kind === 'accepted')).toBe(true);
  expect(
    new Set(replies.map((reply) => (reply.kind === 'accepted' ? reply.turn.id : undefined))).size,
  ).toBe(1);
  expect(await fixture.database.selectFrom('turn_outbox').selectAll().execute()).toHaveLength(1);
});

it('rejects reused request identity with different ordered input without mutation', async () => {
  const thread = await createThread(fixture.database, { ownerId: 'alice', binding });
  const request = { ownerId: 'alice', threadId: thread.id, requestId: randomUUID(), input };
  const accepted = await acceptTurn(fixture.database, request);
  const conflict = await acceptTurn(fixture.database, {
    ...request,
    input: { content: [...input.content].reverse() },
  });
  expect(conflict).toEqual({ kind: 'conflict', reason: 'request_conflict' });
  if (accepted.kind !== 'accepted') throw new Error('Expected accepted fixture');
  expect(
    (await getTurn(fixture.database, { ownerId: 'alice', turnId: accepted.turn.id }))?.input,
  ).toEqual(input);
});

it('admits only one new turn under concurrent distinct request identities', async () => {
  const thread = await createThread(fixture.database, { ownerId: 'alice', binding });
  const replies = await Promise.all(
    Array.from({ length: 8 }, () =>
      acceptTurn(fixture.database, {
        ownerId: 'alice',
        threadId: thread.id,
        requestId: randomUUID(),
        input,
      }),
    ),
  );
  expect(replies.filter((reply) => reply.kind === 'accepted')).toHaveLength(1);
  expect(
    replies.filter((reply) => reply.kind === 'conflict' && reply.reason === 'thread_busy'),
  ).toHaveLength(7);
});

it("does not expose or accept another user's thread or turn", async () => {
  const thread = await createThread(fixture.database, { ownerId: 'alice', binding });
  const accepted = await acceptTurn(fixture.database, {
    ownerId: 'alice',
    threadId: thread.id,
    requestId: randomUUID(),
    input,
  });
  if (accepted.kind !== 'accepted') throw new Error('Expected accepted fixture');
  expect(
    await getThread(fixture.database, { ownerId: 'bob', threadId: thread.id }),
  ).toBeUndefined();
  expect(
    await getTurn(fixture.database, { ownerId: 'bob', turnId: accepted.turn.id }),
  ).toBeUndefined();
  expect(
    await acceptTurn(fixture.database, {
      ownerId: 'bob',
      threadId: thread.id,
      requestId: randomUUID(),
      input,
    }),
  ).toEqual({ kind: 'not_found' });
});

it('rolls back the turn when outbox persistence fails', async () => {
  const thread = await createThread(fixture.database, { ownerId: 'alice', binding });
  await fixture.pool.query(`create function reject_outbox() returns trigger language plpgsql as $$ begin raise exception 'Injected outbox failure'; end $$;
    create trigger reject_outbox before insert on turn_outbox for each row execute function reject_outbox()`);
  await expect(
    acceptTurn(fixture.database, {
      ownerId: 'alice',
      threadId: thread.id,
      requestId: randomUUID(),
      input,
    }),
  ).rejects.toThrow('Injected outbox failure');
  expect(await fixture.database.selectFrom('turns').selectAll().execute()).toEqual([]);
});

it('captures caller input before the first database await', async () => {
  const thread = await createThread(fixture.database, { ownerId: 'alice', binding });
  const part = { type: 'text' as const, text: 'original' };
  const accepting = acceptTurn(fixture.database, {
    ownerId: 'alice',
    threadId: thread.id,
    requestId: randomUUID(),
    input: { content: [part] },
  });
  part.text = 'changed';
  const accepted = await accepting;
  if (accepted.kind !== 'accepted') throw new Error('Expected accepted fixture');
  expect(accepted.turn.input.content[0]?.text).toBe('original');
});

it('claims one attempt before execution and rejects duplicate delivery', async () => {
  const thread = await createThread(fixture.database, { ownerId: 'alice', binding });
  const accepted = await acceptTurn(fixture.database, {
    ownerId: 'alice',
    threadId: thread.id,
    requestId: randomUUID(),
    input,
  });
  if (accepted.kind !== 'accepted') throw new Error('Expected accepted fixture');
  const claims = await Promise.all(
    Array.from({ length: 8 }, () =>
      claimTurn(fixture.database, { turnId: accepted.turn.id, binding }),
    ),
  );
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(await fixture.database.selectFrom('turn_attempts').selectAll().execute()).toHaveLength(1);
  expect(
    (await getTurn(fixture.database, { ownerId: 'alice', turnId: accepted.turn.id }))?.status,
  ).toBe('running');
});

it('keeps unknown execution blocking admission instead of authorizing a replacement', async () => {
  const thread = await createThread(fixture.database, { ownerId: 'alice', binding });
  const accepted = await acceptTurn(fixture.database, {
    ownerId: 'alice',
    threadId: thread.id,
    requestId: randomUUID(),
    input,
  });
  if (accepted.kind !== 'accepted') throw new Error('Expected accepted fixture');
  const claim = await claimTurn(fixture.database, {
    turnId: accepted.turn.id,
    binding,
  });
  if (claim === undefined) throw new Error('Expected claimed fixture');
  await markReconciliation(fixture.database, {
    turnId: claim.turnId,
    attemptId: claim.attemptId,
    code: 'execution_unknown',
  });
  expect(await claimTurn(fixture.database, { turnId: claim.turnId, binding })).toBeUndefined();
  expect(
    await acceptTurn(fixture.database, {
      ownerId: 'alice',
      threadId: thread.id,
      requestId: randomUUID(),
      input,
    }),
  ).toEqual({ kind: 'conflict', reason: 'thread_busy' });
});

it('commits formal output only for its claimed attempt, then makes redelivery a no-op', async () => {
  const thread = await createThread(fixture.database, { ownerId: 'alice', binding });
  const request = { ownerId: 'alice', threadId: thread.id, requestId: randomUUID(), input };
  const accepted = await acceptTurn(fixture.database, request);
  if (accepted.kind !== 'accepted') throw new Error('Expected accepted fixture');
  const claim = await claimTurn(fixture.database, {
    turnId: accepted.turn.id,
    binding,
  });
  if (claim === undefined) throw new Error('Expected claimed fixture');
  const outcome = {
    status: 'completed' as const,
    result: { messages: [{ id: 'answer', role: 'assistant' as const, content: 'Done' }] },
  };
  expect(
    await finishTurn(fixture.database, {
      turnId: claim.turnId,
      attemptId: randomUUID(),
      outcome,
    }),
  ).toBe(false);
  expect(
    await finishTurn(fixture.database, {
      turnId: claim.turnId,
      attemptId: claim.attemptId,
      outcome,
    }),
  ).toBe(true);
  expect(await claimTurn(fixture.database, { turnId: claim.turnId, binding })).toBeUndefined();
  const replay = await acceptTurn(fixture.database, request);
  expect(replay.kind === 'accepted' && replay.turn.status).toBe('completed');
});

it('cancels an unclaimed turn without allocating native execution', async () => {
  const thread = await createThread(fixture.database, { ownerId: 'alice', binding });
  const accepted = await acceptTurn(fixture.database, {
    ownerId: 'alice',
    threadId: thread.id,
    requestId: randomUUID(),
    input,
  });
  if (accepted.kind !== 'accepted') throw new Error('Expected accepted fixture');
  const cancelled = await requestCancellation(fixture.database, {
    ownerId: 'alice',
    turnId: accepted.turn.id,
  });
  expect(cancelled?.status).toBe('cancelled');
  expect(await claimTurn(fixture.database, { turnId: accepted.turn.id, binding })).toBeUndefined();
  expect(await fixture.database.selectFrom('turn_attempts').selectAll().execute()).toEqual([]);
});

it('records cancel intent without inventing a stopped outcome for a running turn', async () => {
  const thread = await createThread(fixture.database, { ownerId: 'alice', binding });
  const accepted = await acceptTurn(fixture.database, {
    ownerId: 'alice',
    threadId: thread.id,
    requestId: randomUUID(),
    input,
  });
  if (accepted.kind !== 'accepted') throw new Error('Expected accepted fixture');
  const claim = await claimTurn(fixture.database, {
    turnId: accepted.turn.id,
    binding,
  });
  if (claim === undefined) throw new Error('Expected claimed fixture');
  expect(
    (
      await requestCancellation(fixture.database, {
        ownerId: 'alice',
        turnId: claim.turnId,
      })
    )?.status,
  ).toBe('running');
  expect(
    await isCancellationRequested(fixture.database, {
      turnId: claim.turnId,
      attemptId: claim.attemptId,
    }),
  ).toBe(true);
});

it('replays case-equivalent UUID spellings as the same request identity', async () => {
  const thread = await createThread(fixture.database, { ownerId: 'alice', binding });
  const request = {
    ownerId: 'alice',
    threadId: thread.id.toUpperCase(),
    requestId: randomUUID(),
    input,
  };
  const accepted = await acceptTurn(fixture.database, request);
  if (accepted.kind !== 'accepted') throw new Error('Expected accepted fixture');
  for (const threadId of [thread.id, thread.id.toUpperCase()]) {
    expect(await acceptTurn(fixture.database, { ...request, threadId })).toMatchObject({
      kind: 'accepted',
      replayed: true,
      turn: { id: accepted.turn.id },
    });
  }
  expect(await fixture.database.selectFrom('turns').selectAll().execute()).toHaveLength(1);
  expect(await fixture.database.selectFrom('turn_outbox').selectAll().execute()).toHaveLength(1);
});

it('rejects a malformed failed terminal row instead of accepting a NULL CHECK result', async () => {
  const thread = await createThread(fixture.database, { ownerId: 'alice', binding });
  const accepted = await acceptTurn(fixture.database, {
    ownerId: 'alice',
    threadId: thread.id,
    requestId: randomUUID(),
    input,
  });
  if (accepted.kind !== 'accepted') throw new Error('Expected accepted fixture');
  await expect(
    fixture.pool.query(
      "update turns set status = 'failed', failure_code = null, finished_at = now() where id = $1",
      [accepted.turn.id],
    ),
  ).rejects.toMatchObject({ code: '23514' });
  await fixture.pool.query(
    "update turns set status = 'failed', failure_code = 'execution_failed', finished_at = now() where id = $1",
    [accepted.turn.id],
  );
  expect(
    (await getTurn(fixture.database, { ownerId: 'alice', turnId: accepted.turn.id }))?.status,
  ).toBe('failed');
});

it('blocks an incompatible persisted SDK binding without allocating an attempt', async () => {
  const thread = await createThread(fixture.database, { ownerId: 'alice', binding });
  const accepted = await acceptTurn(fixture.database, {
    ownerId: 'alice',
    threadId: thread.id,
    requestId: randomUUID(),
    input,
  });
  if (accepted.kind !== 'accepted') throw new Error('Expected accepted fixture');
  await fixture.pool.query('update threads set binding_json = $1::jsonb where id = $2', [
    JSON.stringify({ ...binding, sdkVersion: '0.9.0' }),
    thread.id,
  ]);
  expect(await claimTurn(fixture.database, { turnId: accepted.turn.id, binding })).toBeUndefined();
  expect(
    (await getTurn(fixture.database, { ownerId: 'alice', turnId: accepted.turn.id }))?.status,
  ).toBe('needs_reconciliation');
  expect(await fixture.database.selectFrom('turn_attempts').selectAll().execute()).toEqual([]);
});
