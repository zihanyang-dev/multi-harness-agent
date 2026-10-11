import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { EXECUTE_TURN_JOB_NAME, TURN_QUEUE_NAME } from '@multi-harness/protocol/execution';
import { Worker } from 'bullmq';
import pino from 'pino';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../tests/integration/database.js';
import { createTestQueue } from '../../../../tests/integration/queue.js';
import { acceptTurn } from '../db/submissions.js';
import { createThread } from '../db/threads.js';
import { publishCommands, publishDueTurns } from './command-publication.js';

const binding = {
  harness: 'pi',
  sdkVersion: '1.1.0',
  provider: 'faux',
  model: 'faux',
  policy: 'text-v1',
  storageId: 'test-volume',
} as const;
let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let broker: Awaited<ReturnType<typeof createTestQueue>>;
let turnId: string;

beforeEach(async () => {
  fixture = await createTestDatabase();
  broker = await createTestQueue();
  const thread = await createThread(fixture.database, { ownerId: 'alice', binding });
  const admission = await acceptTurn(fixture.database, {
    ownerId: 'alice',
    threadId: thread.id,
    requestId: randomUUID(),
    input: { content: [{ type: 'text', text: 'Work' }] },
  });
  if (admission.kind !== 'accepted') throw new Error('Expected accepted fixture');
  turnId = admission.turn.id;
});
afterEach(async () => {
  await broker?.dispose();
  await fixture?.dispose();
});

it('publishes only the canonical reference after the acceptance transaction', async () => {
  await publishDueTurns(fixture.database, broker.queue);
  const job = await broker.queue.getJob(`turn-${turnId}-0`);
  expect(job?.name).toBe(EXECUTE_TURN_JOB_NAME);
  expect(job?.data).toEqual({ turnId });
  expect(
    (
      await fixture.database
        .selectFrom('turn_outbox')
        .select('last_published_at')
        .executeTakeFirstOrThrow()
    ).last_published_at,
  ).not.toBeNull();
});

it('isolates a corrupt Redis job without starving other reserved deliveries', async () => {
  const thread = await createThread(fixture.database, { ownerId: 'alice', binding });
  const admission = await acceptTurn(fixture.database, {
    ownerId: 'alice',
    threadId: thread.id,
    requestId: randomUUID(),
    input: { content: [{ type: 'text', text: 'Healthy work' }] },
  });
  if (admission.kind !== 'accepted') throw new Error('Expected accepted fixture');
  const healthyId = admission.turn.id;
  const corruptKey = broker.queue.toKey(`turn-${turnId}-0`);
  await broker.connection.set(corruptKey, 'not-a-job-hash');
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      // The corrupt delivery must precede the healthy one on both reservations.
      await fixture.database
        .updateTable('turn_outbox')
        .set({ next_delivery_at: new Date(1) })
        .execute();
      await fixture.database
        .updateTable('turn_outbox')
        .set({ next_delivery_at: new Date(0) })
        .where('turn_id', '=', turnId)
        .execute();
      let failure: unknown;
      try {
        await publishDueTurns(fixture.database, broker.queue);
      } catch (error) {
        failure = error;
      }
      expect(await broker.queue.getJob(`turn-${healthyId}-0`)).toBeDefined();
      expect(failure).toEqual(new Error('command_publication_failed'));
      const failed = await fixture.database
        .selectFrom('turn_outbox')
        .selectAll()
        .where('turn_id', '=', turnId)
        .executeTakeFirstOrThrow();
      expect(failed.last_published_at).toBeNull();
      expect(failed.generation).toBe(0);
      expect(failed.next_delivery_at.getTime()).toBeGreaterThan(Date.now());
    }
  } finally {
    await broker.connection.del(corruptKey);
  }
  await fixture.database
    .updateTable('turn_outbox')
    .set({ next_delivery_at: new Date(0) })
    .where('turn_id', '=', turnId)
    .execute();
  await publishDueTurns(fixture.database, broker.queue);
  expect(await broker.queue.getJob(`turn-${turnId}-0`)).toBeDefined();
});

it('republishes after Redis notification loss even though enqueue was acknowledged', async () => {
  await publishDueTurns(fixture.database, broker.queue);
  await (await broker.queue.getJob(`turn-${turnId}-0`))?.remove();
  await fixture.database
    .updateTable('turn_outbox')
    .set({ next_delivery_at: new Date(0) })
    .execute();
  await publishDueTurns(fixture.database, broker.queue);
  expect(await broker.queue.getJob(`turn-${turnId}-0`)).toBeDefined();
});

it('uses a new generation instead of trusting a retained terminal job', async () => {
  const connection = broker.connection.duplicate({ maxRetriesPerRequest: null });
  const worker = new Worker(TURN_QUEUE_NAME, async () => {}, { connection, prefix: broker.prefix });
  const completed = Promise.withResolvers<void>();
  worker.once('completed', () => completed.resolve());
  worker.on('error', () => completed.reject(new Error('Test consumer failed')));
  try {
    await worker.waitUntilReady();
    // A queue consumer can finish its notification without claiming the canonical turn.
    await broker.queue.add(EXECUTE_TURN_JOB_NAME, { turnId }, { jobId: `turn-${turnId}-0` });
    await completed.promise;
  } finally {
    await worker.close();
    connection.disconnect();
  }
  await publishDueTurns(fixture.database, broker.queue);
  expect(await broker.queue.getJob(`turn-${turnId}-1`)).toBeDefined();
});

it('does not enqueue a turn already claimed by a worker', async () => {
  await fixture.database
    .updateTable('turns')
    .set({ status: 'running' })
    .where('id', '=', turnId)
    .execute();
  await publishDueTurns(fixture.database, broker.queue);
  expect(await broker.queue.getJobs(['waiting', 'active'])).toEqual([]);
});

it('does not reserve or publish commands when already cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  const before = await fixture.database.selectFrom('turn_outbox').selectAll().execute();
  await publishCommands(
    fixture.database,
    broker.queue,
    controller.signal,
    pino({ enabled: false }),
  );
  expect(await fixture.database.selectFrom('turn_outbox').selectAll().execute()).toEqual(before);
  expect(await broker.queue.getJobs(['waiting', 'active'])).toEqual([]);
});

it('cancels the poll wait promptly after publishing a committed command', async () => {
  const controller = new AbortController();
  const publishing = publishCommands(
    fixture.database,
    broker.queue,
    controller.signal,
    pino({ enabled: false }),
  );
  try {
    await waitForPublished();
    controller.abort();
    await Promise.race([
      publishing,
      setTimeout(500).then(() => {
        throw new Error('Publisher did not cancel its wait');
      }),
    ]);
  } finally {
    controller.abort();
    await publishing;
  }
});

it('bounds failure diagnostics and retries publication on the next poll', async () => {
  await fixture.pool.query('alter table turn_outbox rename to temporarily_unavailable_outbox');
  const lines: string[] = [];
  const observed = Promise.withResolvers<void>();
  const logger = pino(
    {},
    {
      write(line: string) {
        lines.push(line);
        observed.resolve();
      },
    },
  );
  const controller = new AbortController();
  const publishing = publishCommands(fixture.database, broker.queue, controller.signal, logger);
  try {
    await observed.promise;
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        code: 'command_publication_failed',
        msg: 'Command publication failed',
      }),
    ]);
    const diagnostic = JSON.parse(lines[0] ?? '{}');
    expect(Object.keys(diagnostic).sort()).toEqual([
      'code',
      'hostname',
      'level',
      'msg',
      'pid',
      'time',
    ]);
    await fixture.pool.query('alter table temporarily_unavailable_outbox rename to turn_outbox');
    await waitForPublished();
    expect(await broker.queue.getJob(`turn-${turnId}-0`)).toBeDefined();
  } finally {
    controller.abort();
    await publishing;
  }
});

async function waitForPublished(): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const row = await fixture.database
      .selectFrom('turn_outbox')
      .select('last_published_at')
      .executeTakeFirstOrThrow();
    if (row.last_published_at !== null) return;
    await setTimeout(20);
  }
  throw new Error('Command publication timed out');
}
