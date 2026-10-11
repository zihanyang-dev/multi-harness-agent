import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { HarnessTurnResult } from '@multi-harness/harness';
import { EXECUTE_TURN_JOB_NAME } from '@multi-harness/protocol/execution';
import { Worker as BullWorker } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDatabase } from '../../../tests/integration/database.js';
import { createTestQueue } from '../../../tests/integration/queue.js';
import { publishDueTurns } from '../../server/src/conversation/command-publication.js';
import { acceptTurn } from '../../server/src/db/submissions.js';
import { createThread } from '../../server/src/db/threads.js';
import type { PiTurnHost } from './contract.js';
import { startWorker, type Worker } from './worker.js';

const binding = {
  harness: 'pi',
  sdkVersion: '1.1.0',
  provider: 'faux',
  model: 'faux',
  policy: 'text-v1',
  storageId: 'test-volume',
} as const;
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let redis: Awaited<ReturnType<typeof createTestQueue>>;
let connection: Redis;
let runtime: Worker | undefined;
const releaseHosts: Array<() => void> = [];

beforeEach(async () => {
  db = await createTestDatabase();
  redis = await createTestQueue();
  const url = process.env.TEST_REDIS_URL;
  if (url === undefined) throw new Error('TEST_REDIS_URL is required');
  connection = new Redis(url, { maxRetriesPerRequest: null });
  await new Promise<void>((resolve) => connection.once('ready', resolve));
});
afterEach(async () => {
  for (const release of releaseHosts.splice(0)) release();
  try {
    await runtime?.close();
  } finally {
    runtime = undefined;
    connection?.disconnect();
    try {
      await redis?.dispose();
    } finally {
      await db?.dispose();
    }
  }
});
function controlled() {
  const invoked = Promise.withResolvers<void>();
  const interrupted = Promise.withResolvers<void>();
  const cleaning = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const receipt = Promise.withResolvers<HarnessTurnResult>();
  releaseHosts.push(() => {
    receipt.resolve({ status: 'cancelled', messages: [] });
    cleanup.resolve();
  });
  let opens = 0;
  const host: PiTurnHost = {
    binding,
    openSession: async () => {
      opens++;
      return {
        nativeSessionId: randomUUID(),
        run: async () => {
          invoked.resolve();
          return {
            events: {
              [Symbol.asyncIterator]() {
                throw new Error('unused');
              },
            },
            result: receipt.promise,
            interrupt: async () => {
              interrupted.resolve();
            },
          };
        },
        dispose: async () => {
          cleaning.resolve();
          await cleanup.promise;
        },
      };
    },
  };
  return { host, invoked, interrupted, cleaning, cleanup, receipt, opens: () => opens };
}
async function start(host: PiTurnHost) {
  await publishDueTurns(db.database, redis.queue);
  runtime = startWorker({
    database: db.database,
    prefix: redis.prefix,
    connection,
    host,
    maxRunMs: 10_000,
    logger: pino({ level: 'silent' }),
  });
  return runtime;
}
async function accepted() {
  const thread = await createThread(db.database, { ownerId: 'alice', binding });
  const reply = await acceptTurn(db.database, {
    ownerId: 'alice',
    threadId: thread.id,
    requestId: randomUUID(),
    input: { content: [{ type: 'text', text: 'Hello' }] },
  });
  if (reply.kind !== 'accepted') throw new Error('Expected accepted');
  return reply.turn.id;
}
async function row(id: string) {
  return db.database.selectFrom('turns').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}
const completed: HarnessTurnResult = {
  status: 'completed',
  messages: [{ id: 'answer', role: 'assistant', content: 'Done' }],
};

it('processes explicitly published accepted work through the native worker and does not rerun duplicate delivery', async () => {
  const id = await accepted();
  const c = controlled();
  const r = await start(c.host);
  await c.invoked.promise;
  await redis.queue.add(EXECUTE_TURN_JOB_NAME, { turnId: id }, { jobId: `turn-${id}-2` });
  c.receipt.resolve(completed);
  await c.cleaning.promise;
  expect((await row(id)).status).toBe('running');
  c.cleanup.resolve();
  await expect.poll(async () => (await row(id)).status).toBe('completed');
  await expect
    .poll(async () => (await redis.queue.getJob(`turn-${id}-2`))?.getState())
    .toBe('completed');
  expect(c.opens()).toBe(1);
  expect((await row(id)).result_json).toEqual({ messages: completed.messages });
  await r.close();
  await r.finished;
  expect(await connection.ping()).toBe('PONG');
  expect(await redis.connection.ping()).toBe('PONG');
});

it('rejects malformed payloads, UUID references, names and noncanonical IDs without allocation or private failure text', async () => {
  const c = controlled();
  c.cleanup.resolve();
  await start(c.host);
  const uuid = randomUUID();
  const inputs = [
    {
      name: EXECUTE_TURN_JOB_NAME,
      data: { turnId: uuid, secret: 'private-secret' },
      id: `turn-${uuid}-1`,
    },
    { name: EXECUTE_TURN_JOB_NAME, data: { turnId: 'private-secret' }, id: 'invalid-uuid' },
    { name: 'private-secret', data: { turnId: uuid }, id: `turn-${uuid}-2` },
    { name: EXECUTE_TURN_JOB_NAME, data: { turnId: uuid }, id: `turn-${uuid}-01` },
  ];
  for (const input of inputs) {
    const job = await redis.queue.add(input.name, input.data, { jobId: input.id });
    await expect.poll(() => job.getState()).toBe('failed');
    const failed = await redis.queue.getJob(input.id);
    expect(failed?.failedReason).toBe('invalid_turn_job');
    expect(JSON.stringify(failed?.stacktrace)).not.toContain('private-secret');
  }
  expect(c.opens()).toBe(0);
  expect(await db.database.selectFrom('turn_attempts').selectAll().execute()).toEqual([]);
});

it('shutdown interrupts but joins uncooperative native execution and blocking cleanup', async () => {
  const id = await accepted();
  const c = controlled();
  const r = await start(c.host);
  await c.invoked.promise;
  const closing = r.close();
  expect(r.close()).toBe(closing);
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  await c.interrupted.promise;
  await delay(50);
  expect(closed).toBe(false);
  c.receipt.resolve({ status: 'cancelled', messages: [] });
  await c.cleaning.promise;
  await delay(50);
  expect(closed).toBe(false);
  expect((await row(id)).status).toBe('running');
  c.cleanup.resolve();
  await closing;
  await r.finished;
  expect((await row(id)).status).toBe('cancelled');
});

it('joins processor completion even when native close returns before the processor', async () => {
  const id = await accepted();
  const c = controlled();
  const r = await start(c.host);
  await c.invoked.promise;
  const nativeClosed = Promise.withResolvers<void>();
  const nativeClose = BullWorker.prototype.close;
  // Native close can return early after blocking-disconnect failure. Force-close exercises
  // that same boundary using the public native API, without replacing the real processor.
  const close = vi.spyOn(BullWorker.prototype, 'close').mockImplementation(function (
    this: BullWorker,
  ) {
    return nativeClose.call(this, true).finally(() => nativeClosed.resolve());
  });
  try {
    let closed = false;
    const closing = r.close();
    void closing.then(() => {
      closed = true;
    });
    await nativeClosed.promise;
    await c.interrupted.promise;
    await delay(30);
    expect(closed).toBe(false);
    expect((await row(id)).status).toBe('running');

    c.receipt.resolve({ status: 'cancelled', messages: [] });
    await c.cleaning.promise;
    await delay(30);
    expect(closed).toBe(false);
    c.cleanup.resolve();
    await closing;
    expect((await row(id)).status).toBe('cancelled');
  } finally {
    c.receipt.resolve({ status: 'cancelled', messages: [] });
    c.cleanup.resolve();
    await r.finished;
    close.mockRestore();
    // Force-close leaves the broker job active; native execution has now actually joined.
    await redis.queue.obliterate({ force: true });
  }
});

it('maps execution exceptions to a generic nonretryable Redis failure', async () => {
  const id = await accepted();
  const c = controlled();
  const host: PiTurnHost = {
    get binding(): PiTurnHost['binding'] {
      throw new Error('private-host-configuration');
    },
    openSession: c.host.openSession,
  };
  await start(host);
  const jobId = `turn-${id}-0`;
  await expect.poll(async () => (await redis.queue.getJob(jobId))?.getState()).toBe('failed');
  const failed = await redis.queue.getJob(jobId);
  expect(failed?.failedReason).toBe('turn_execution_failed');
  expect(JSON.stringify(failed?.stacktrace)).not.toContain('private-host-configuration');
  expect((await row(id)).status).toBe('accepted');
  expect(c.opens()).toBe(0);
});

it('does not publish product outbox commands while supervising intake', async () => {
  const id = await accepted();
  const c = controlled();
  c.receipt.resolve(completed);
  c.cleanup.resolve();
  runtime = startWorker({
    database: db.database,
    prefix: redis.prefix,
    connection,
    host: c.host,
    maxRunMs: 10_000,
    logger: pino({ level: 'silent' }),
  });

  await delay(150);
  expect(await redis.queue.getJob(`turn-${id}-0`)).toBeUndefined();
  expect((await row(id)).status).toBe('accepted');
  expect(c.opens()).toBe(0);
  await publishDueTurns(db.database, redis.queue);
  await expect.poll(async () => (await row(id)).status).toBe('completed');
  expect(c.opens()).toBe(1);
});
