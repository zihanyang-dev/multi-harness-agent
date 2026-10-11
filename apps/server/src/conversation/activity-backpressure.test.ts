import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { closeDatabase, createDatabase } from '@multi-harness/database';
import { type Turn, TurnSchema } from '@multi-harness/protocol/http';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import * as history from '../db/conversation-history.js';
import * as activity from './activity-stream.js';

async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Native HTTP lifecycle exceeded bound')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

it.each(['shutdown', 'write timeout'] as const)(
  'releases a backpressured native TCP connection on %s',
  async (reason) => {
    const turn: Turn = TurnSchema.parse({
      id: randomUUID(),
      threadId: randomUUID(),
      input: { content: [{ type: 'text', text: 'hello' }] },
      status: 'running',
      result: null,
      failureCode: null,
      acceptedAt: new Date().toISOString(),
      finishedAt: null,
    });
    // No database or Redis service is contacted: only observation reads are stubbed.
    const pool = new Pool();
    const database = createDatabase(pool);
    const redis = new Redis({ lazyConnect: true });
    vi.spyOn(history, 'getTurn').mockResolvedValue(turn);
    const frames = Array.from({ length: 100 }, (_, index) => [
      `${index + 1}-0`,
      [
        'activity',
        JSON.stringify({
          turnId: turn.id,
          event: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'x'.repeat(32000) },
        }),
      ],
    ]);
    vi.spyOn(redis, 'eval').mockResolvedValue(['1-0', '100-0', 0, frames]);
    const shutdown = new AbortController();
    let finishObserver: () => void = () => {};
    const observerFinished = new Promise<void>((resolve) => {
      finishObserver = resolve;
    });
    const original = activity.streamTurnActivity;
    vi.spyOn(activity, 'streamTurnActivity').mockImplementation(async (...args) => {
      try {
        await original(...args);
      } finally {
        finishObserver();
      }
    });
    const app = createApp({
      database,
      binding: {
        harness: 'pi',
        sdkVersion: '1.1.0',
        provider: 'faux',
        model: 'faux',
        policy: 'text-v1',
        storageId: 'test',
      },
      trustedOrigin: 'http://localhost',
      getOwnerId: async () => 'alice',
      handleAuth: async () => new Response(),
      activity: { connection: redis, prefix: 'backpressure-test', shutdown: shutdown.signal },
    });
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing TCP address');
    const connected = new Promise<Socket>((resolve) => server.once('connection', resolve));
    const client = connect({ host: '127.0.0.1', port: address.port });
    client.on('error', () => {});
    client.pause();
    const socket = await connected;
    const physicallyClosed = once(socket, 'close');
    const request = new Promise<ServerResponse>((resolve) => {
      server.once('request', (_request: IncomingMessage, response: ServerResponse) =>
        resolve(response),
      );
    });
    let closeServer: Promise<void> | undefined;
    try {
      if (client.connecting) await once(client, 'connect');
      client.write(`GET /turns/${turn.id}/events HTTP/1.1\r\nHost: localhost\r\n\r\n`);
      const response = await request;
      await bounded(
        (async () => {
          for (let attempt = 0; attempt < 90; attempt++) {
            if (response.writableNeedDrain) return;
            await delay(5);
          }
          throw new Error('Fixture did not reach native write backpressure');
        })(),
        500,
      );
      if (reason === 'shutdown') shutdown.abort();
      await bounded(observerFinished, reason === 'shutdown' ? 500 : 1800);
      await bounded(physicallyClosed, 500);
      expect(server.listening).toBe(true);
      expect(shutdown.signal.aborted).toBe(reason === 'shutdown');
      closeServer = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await bounded(closeServer, 500);
      expect(socket.destroyed).toBe(true);
    } finally {
      shutdown.abort();
      client.destroy();
      socket.destroy();
      if (closeServer === undefined)
        closeServer = new Promise((resolve) => server.close(() => resolve()));
      await closeServer;
      redis.disconnect();
      await closeDatabase(database, pool);
      vi.restoreAllMocks();
    }
  },
);
