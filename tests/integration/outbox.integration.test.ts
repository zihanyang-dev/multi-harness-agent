import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, expect, it } from 'vitest';

import {
  advanceDelivery,
  notePublished,
  reserveDeliveries,
} from '../../apps/server/src/db/command-publication.js';
import { acceptTurn } from '../../apps/server/src/db/submissions.js';
import { createThread } from '../../apps/server/src/db/threads.js';
import { claimTurn } from '../../apps/worker/src/execution/db/turns.js';
import { createTestDatabase } from './database.js';

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
  const reply = await acceptTurn(fixture.database, {
    ownerId: 'alice',
    threadId: thread.id,
    requestId: randomUUID(),
    input: { content: [{ type: 'text', text: 'Work' }] },
  });
  if (reply.kind !== 'accepted') throw new Error('Expected accepted fixture');
  turnId = reply.turn.id;
});
afterEach(async () => {
  await fixture?.dispose();
});

it('reserves small due batches without duplicate concurrent reservations', async () => {
  const batches = await Promise.all(
    Array.from({ length: 4 }, () =>
      reserveDeliveries(fixture.database, { limit: 20, redeliveryDelayMs: 10000 }),
    ),
  );
  expect(batches.flat()).toEqual([{ turnId, generation: 0 }]);
});

it('rediscovers a published but unclaimed turn instead of treating enqueue as durable acceptance', async () => {
  const [delivery] = await reserveDeliveries(fixture.database, {
    limit: 20,
    redeliveryDelayMs: 10000,
  });
  if (delivery === undefined) throw new Error('Expected delivery fixture');
  await notePublished(fixture.database, delivery);
  await fixture.database
    .updateTable('turn_outbox')
    .where('turn_id', '=', turnId)
    .set({ next_delivery_at: new Date(0) })
    .execute();
  expect(
    await reserveDeliveries(fixture.database, {
      limit: 20,
      redeliveryDelayMs: 10000,
    }),
  ).toEqual([delivery]);
});

it('stops notification rediscovery after durable worker acceptance', async () => {
  await claimTurn(fixture.database, { turnId, binding });
  expect(
    await reserveDeliveries(fixture.database, {
      limit: 20,
      redeliveryDelayMs: 10000,
    }),
  ).toEqual([]);
});

it('advances only the current delivery generation while the canonical turn remains eligible', async () => {
  const initial = { turnId, generation: 0 };
  expect(await advanceDelivery(fixture.database, initial)).toEqual({
    turnId,
    generation: 1,
  });
  expect(await advanceDelivery(fixture.database, initial)).toBeUndefined();
  await claimTurn(fixture.database, { turnId, binding });
  expect(await advanceDelivery(fixture.database, { turnId, generation: 1 })).toBeUndefined();
});
