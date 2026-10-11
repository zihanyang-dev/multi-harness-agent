import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { type BaseEvent, EventType } from '@ag-ui/core';
import type { HarnessRun, HarnessSession, HarnessTurnResult } from '@multi-harness/harness';
import pino from 'pino';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../tests/integration/database.js';
import { createTestQueue } from '../../../../tests/integration/queue.js';
import { publishDueTurns } from '../../../server/src/conversation/command-publication.js';
import { acceptTurn } from '../../../server/src/db/submissions.js';
import { createThread } from '../../../server/src/db/threads.js';
import { startWorker } from '../worker.js';
import { executeTurn } from './execute-turn.js';

const binding = {
  harness: 'pi',
  sdkVersion: '1.1.0',
  provider: 'faux',
  model: 'faux',
  policy: 'text-v1',
  storageId: 'activity-test',
} as const;
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let broker: Awaited<ReturnType<typeof createTestQueue>>;
beforeEach(async () => {
  database = await createTestDatabase();
  broker = await createTestQueue();
});
afterEach(async () => {
  await Promise.all([database.dispose(), broker.dispose()]);
});

it('publishes genuine native deltas while execution is still running without committing provisional text', async () => {
  const thread = await createThread(database.database, { ownerId: 'alice', binding });
  const accepted = await acceptTurn(database.database, {
    ownerId: 'alice',
    threadId: thread.id,
    requestId: randomUUID(),
    input: { content: [{ type: 'text', text: 'Hello' }] },
  });
  if (accepted.kind !== 'accepted') throw new Error('Expected accepted turn');
  const result = Promise.withResolvers<HarnessTurnResult>();
  const observed = Promise.withResolvers<void>();
  const run: HarnessRun = {
    events: (async function* (): AsyncGenerator<BaseEvent> {
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId: 'draft',
        role: 'assistant',
      } as BaseEvent;
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'draft',
        delta: 'Actual first delta',
      } as BaseEvent;
      observed.resolve();
      await result.promise;
      yield { type: EventType.TEXT_MESSAGE_END, messageId: 'draft' } as BaseEvent;
    })(),
    result: result.promise,
    interrupt: async () => {},
  };
  const session: HarnessSession = {
    nativeSessionId: randomUUID(),
    run: async () => run,
    dispose: async () => {},
  };
  const executing = executeTurn(database.database, {
    turnId: accepted.turn.id,
    host: { binding, openSession: async () => session },
    signal: new AbortController().signal,
    maxRunMs: 5000,
    activity: { connection: broker.connection, prefix: broker.prefix },
  });
  try {
    await Promise.race([
      observed.promise,
      delay(1500).then(() => {
        throw new Error('Native activity was not observed');
      }),
    ]);
    const frames = await broker.connection.xrange(
      `${broker.prefix}:turn-events:${accepted.turn.id}`,
      '-',
      '+',
    );
    expect(frames.map(([, fields]) => JSON.parse(fields[1] ?? '{}').event)).toContainEqual({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'draft',
      delta: 'Actual first delta',
    });
    const row = await database.database
      .selectFrom('turns')
      .select(['status', 'result_json'])
      .where('id', '=', accepted.turn.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'running', result_json: null });
  } finally {
    result.resolve({
      status: 'completed',
      messages: [{ id: 'formal', role: 'assistant', content: 'Formal answer' }],
    });
    await executing;
  }
  const row = await database.database
    .selectFrom('turns')
    .select(['status', 'result_json'])
    .where('id', '=', accepted.turn.id)
    .executeTakeFirstOrThrow();
  expect(row.status).toBe('completed');
  expect(row.result_json).toEqual({
    messages: [{ id: 'formal', role: 'assistant', content: 'Formal answer' }],
  });
});

it('publishes from the BullMQ processor and leaves borrowed infrastructure open after joined close', async () => {
  const thread = await createThread(database.database, { ownerId: 'alice', binding });
  const accepted = await acceptTurn(database.database, {
    ownerId: 'alice',
    threadId: thread.id,
    requestId: randomUUID(),
    input: { content: [{ type: 'text', text: 'Hello' }] },
  });
  if (accepted.kind !== 'accepted') throw new Error('Expected accepted turn');
  const result = Promise.withResolvers<HarnessTurnResult>();
  const observed = Promise.withResolvers<void>();
  const run: HarnessRun = {
    events: (async function* (): AsyncGenerator<BaseEvent> {
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'draft',
        delta: 'Processor delta',
      } as BaseEvent;
      observed.resolve();
      await result.promise;
    })(),
    result: result.promise,
    interrupt: async () => {},
  };
  const connection = broker.connection.duplicate({ maxRetriesPerRequest: null });
  await connection.connect();
  const worker = startWorker({
    database: database.database,
    connection,
    prefix: broker.prefix,
    host: {
      binding,
      openSession: async () => ({
        nativeSessionId: randomUUID(),
        run: async () => run,
        dispose: async () => {},
      }),
    },
    maxRunMs: 5000,
    logger: pino({ enabled: false }),
  });
  try {
    await publishDueTurns(database.database, broker.queue);
    await Promise.race([
      observed.promise,
      delay(1500).then(() => {
        throw new Error('Processor activity was not observed');
      }),
    ]);
    const frames = await broker.connection.xrange(
      `${broker.prefix}:turn-events:${accepted.turn.id}`,
      '-',
      '+',
    );
    expect(frames).toHaveLength(1);
  } finally {
    result.resolve({ status: 'completed', messages: [] });
    await worker.close();
    expect(await connection.ping()).toBe('PONG');
    connection.disconnect();
  }
});

it('does not turn a failed observer into execution failure or cancel native ownership', async () => {
  const thread = await createThread(database.database, { ownerId: 'alice', binding });
  const accepted = await acceptTurn(database.database, {
    ownerId: 'alice',
    threadId: thread.id,
    requestId: randomUUID(),
    input: { content: [{ type: 'text', text: 'Hello' }] },
  });
  if (accepted.kind !== 'accepted') throw new Error('Expected accepted turn');
  let interruptions = 0;
  const run: HarnessRun = {
    events: {
      [Symbol.asyncIterator]() {
        throw new Error('Private observer error');
      },
    },
    result: Promise.resolve({
      status: 'completed',
      messages: [{ id: 'formal', role: 'assistant', content: 'Done' }],
    }),
    interrupt: async () => {
      interruptions++;
    },
  };
  await executeTurn(database.database, {
    turnId: accepted.turn.id,
    host: {
      binding,
      openSession: async () => ({
        nativeSessionId: randomUUID(),
        run: async () => run,
        dispose: async () => {},
      }),
    },
    signal: new AbortController().signal,
    maxRunMs: 5000,
    activity: { connection: broker.connection, prefix: broker.prefix },
  });
  expect(interruptions).toBe(0);
  expect(
    (
      await database.database
        .selectFrom('turns')
        .select('status')
        .where('id', '=', accepted.turn.id)
        .executeTakeFirstOrThrow()
    ).status,
  ).toBe('completed');
});
