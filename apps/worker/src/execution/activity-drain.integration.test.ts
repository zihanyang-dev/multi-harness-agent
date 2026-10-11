import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { type Event, EventType } from '@ag-ui/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDatabase } from '../../../../tests/integration/database.js';
import { createTestQueue } from '../../../../tests/integration/queue.js';
import { acceptTurn } from '../../../server/src/db/submissions.js';
import { createThread } from '../../../server/src/db/threads.js';
import { executeTurn } from './execute-turn.js';

const binding = {
  harness: 'pi',
  sdkVersion: '1.1.0',
  provider: 'faux',
  model: 'faux',
  policy: 'text-v1',
  storageId: 'activity-drain-test',
} as const;
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let broker: Awaited<ReturnType<typeof createTestQueue>>;
beforeEach(async () => {
  database = await createTestDatabase();
  broker = await createTestQueue();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([database.dispose(), broker.dispose()]);
});

it.each([false, true])(
  'bounds the observation drain after native settlement (shutdown=%s)',
  async (shutdown) => {
    const thread = await createThread(database.database, { ownerId: 'alice', binding });
    const accepted = await acceptTurn(database.database, {
      ownerId: 'alice',
      threadId: thread.id,
      requestId: randomUUID(),
      input: { content: [{ type: 'text', text: 'Hello' }] },
    });
    if (accepted.kind !== 'accepted') throw new Error('Expected accepted turn');
    const firstWrite = Promise.withResolvers<void>();
    const cleaned = Promise.withResolvers<void>();
    const controller = new AbortController();
    const append = broker.connection.eval.bind(broker.connection);
    let slow = true;
    let interruptions = 0;
    vi.spyOn(broker.connection, 'eval').mockImplementation(async (...args) => {
      firstWrite.resolve();
      await delay(slow ? 15 : 0);
      return append(...args);
    });
    const executing = executeTurn(database.database, {
      turnId: accepted.turn.id,
      host: {
        binding,
        openSession: async () => ({
          nativeSessionId: randomUUID(),
          run: async () => ({
            events: (async function* (): AsyncGenerator<Event> {
              for (let i = 0; i < 256; i++)
                yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'draft', delta: 'x' };
            })(),
            result: Promise.resolve({
              status: 'completed',
              messages: [{ id: 'formal', role: 'assistant', content: 'Done' }],
            }),
            interrupt: async () => {
              interruptions++;
            },
          }),
          dispose: async () => {
            cleaned.resolve();
          },
        }),
      },
      signal: controller.signal,
      maxRunMs: 5000,
      activity: { connection: broker.connection, prefix: broker.prefix },
    });
    try {
      await firstWrite.promise;
      if (shutdown) controller.abort();
      await Promise.race([
        cleaned.promise,
        delay(1000).then(() => {
          throw new Error('Observation backlog delayed native cleanup');
        }),
      ]);
      await executing;
      const row = await database.database
        .selectFrom('turns')
        .select(['status', 'result_json'])
        .where('id', '=', accepted.turn.id)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('completed');
      expect(row.result_json).toEqual({
        messages: [{ id: 'formal', role: 'assistant', content: 'Done' }],
      });
      expect(interruptions).toBe(0);
      const events = await broker.connection.xrange(
        `${broker.prefix}:turn-events:${accepted.turn.id}`,
        '-',
        '+',
      );
      expect(events.at(-1)?.[1]).toEqual(['gap', 'activity_unavailable']);
    } finally {
      slow = false;
      await executing;
    }
  },
);
