import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../tests/integration/database.js';
import { requestCancellation } from './cancellations.js';
import { acceptTurn } from './submissions.js';
import { createThread } from './threads.js';

const binding = {
  harness: 'pi',
  sdkVersion: '1.1.0',
  provider: 'faux',
  model: 'faux',
  policy: 'text-v1',
  storageId: 'test-volume',
} as const;
let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let turnId: string;

beforeEach(async () => {
  fixture = await createTestDatabase();
  const thread = await createThread(fixture.database, { ownerId: 'alice', binding });
  const admitted = await acceptTurn(fixture.database, {
    ownerId: 'alice',
    threadId: thread.id,
    requestId: randomUUID(),
    input: { content: [{ type: 'text', text: 'Work' }] },
  });
  if (admitted.kind !== 'accepted') throw new Error('Expected accepted fixture');
  turnId = admitted.turn.id;
});
afterEach(async () => {
  await fixture?.dispose();
});

it('cancels unclaimed work atomically without allocating execution', async () => {
  const cancelled = await requestCancellation(fixture.database, { ownerId: 'alice', turnId });
  expect(cancelled).toMatchObject({ status: 'cancelled', result: { messages: [] } });
  expect(cancelled?.finishedAt).not.toBeNull();
  const repeated = await requestCancellation(fixture.database, { ownerId: 'alice', turnId });
  expect(repeated).toEqual(cancelled);
  expect(await fixture.database.selectFrom('turn_attempts').selectAll().execute()).toEqual([]);
});

it('preserves the first active cancel request and does not invent shutdown', async () => {
  await fixture.database
    .updateTable('turns')
    .set({ status: 'running' })
    .where('id', '=', turnId)
    .execute();
  const cancelled = await requestCancellation(fixture.database, { ownerId: 'alice', turnId });
  expect(cancelled).toMatchObject({ status: 'running', result: null, finishedAt: null });
  const first = await fixture.database
    .selectFrom('turns')
    .select('cancel_requested_at')
    .where('id', '=', turnId)
    .executeTakeFirstOrThrow();
  await requestCancellation(fixture.database, { ownerId: 'alice', turnId });
  const repeated = await fixture.database
    .selectFrom('turns')
    .select('cancel_requested_at')
    .where('id', '=', turnId)
    .executeTakeFirstOrThrow();
  expect(first.cancel_requested_at).toBeInstanceOf(Date);
  expect(repeated).toEqual(first);
});

it('makes absent and foreign cancel requests equally invisible without mutation', async () => {
  for (const options of [
    { ownerId: 'bob', turnId },
    { ownerId: 'alice', turnId: randomUUID() },
  ]) {
    expect(await requestCancellation(fixture.database, options)).toBeUndefined();
  }
  const row = await fixture.database
    .selectFrom('turns')
    .select(['status', 'cancel_requested_at'])
    .where('id', '=', turnId)
    .executeTakeFirstOrThrow();
  expect(row).toEqual({ status: 'accepted', cancel_requested_at: null });
});
