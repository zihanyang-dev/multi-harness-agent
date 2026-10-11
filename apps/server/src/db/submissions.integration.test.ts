import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { createTestDatabase } from '../../../../tests/integration/database.js';
import { getTurn } from './conversation-history.js';
import { acceptTurn } from './submissions.js';
import { createThread, getThread } from './threads.js';

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

it('rejects one owner request key racing across threads while other owners can reuse that key', async () => {
  const aliceThreads = await Promise.all([
    createThread(fixture.database, { ownerId: 'alice', binding }),
    createThread(fixture.database, { ownerId: 'alice', binding }),
  ]);
  const requestId = randomUUID();
  const replies = await Promise.all(
    aliceThreads.map((thread) =>
      acceptTurn(fixture.database, {
        ownerId: 'alice',
        threadId: thread.id,
        requestId,
        input,
      }),
    ),
  );
  expect(replies.filter((reply) => reply.kind === 'accepted')).toHaveLength(1);
  expect(replies.filter((reply) => reply.kind === 'conflict')).toEqual([
    { kind: 'conflict', reason: 'request_conflict' },
  ]);
  const bobThread = await createThread(fixture.database, { ownerId: 'bob', binding });
  expect(
    await acceptTurn(fixture.database, {
      ownerId: 'bob',
      threadId: bobThread.id,
      requestId,
      input,
    }),
  ).toMatchObject({ kind: 'accepted', replayed: false });
  expect(await fixture.database.selectFrom('turns').selectAll().execute()).toHaveLength(2);
  expect(await fixture.database.selectFrom('turn_outbox').selectAll().execute()).toHaveLength(2);
});
