import { randomUUID } from 'node:crypto';
import { ThreadSchema, TurnSchema } from '@multi-harness/protocol/http';
import { pino } from 'pino';
import { expect, it } from 'vitest';

import { createTestDatabase } from '../../../tests/integration/database.js';
import { createTestQueue } from '../../../tests/integration/queue.js';
import { startServer } from './server.js';

it('publishes an authenticated durable submission from the server-owned lifetime', async () => {
  const fixture = await createTestDatabase();
  const broker = await createTestQueue();
  const { connectionString, options } = fixture.pool.options;
  const redisURL = process.env.TEST_REDIS_URL;
  if (connectionString === undefined || options === undefined || redisURL === undefined)
    throw new Error('Expected isolated infrastructure fixture');
  const databaseURL = new URL(connectionString);
  databaseURL.searchParams.set('options', options);
  const origin = 'http://localhost:3000';
  const server = await startServer(
    {
      hostname: '127.0.0.1',
      port: 0,
      backend: {
        databaseURL: databaseURL.toString(),
        redisURL,
        prefix: broker.prefix,
        baseURL: origin,
        secret: 'local-test-only-secret-at-least-32-characters',
        allowSignUp: true,
        binding: {
          harness: 'pi',
          sdkVersion: '1.1.0',
          provider: 'faux',
          model: 'faux',
          policy: 'text-v1',
          storageId: 'test-volume',
        },
      },
    },
    pino({ level: 'silent' }),
  );
  try {
    const baseURL = `http://127.0.0.1:${server.port}`;
    const signedUp = await fetch(`${baseURL}/auth/sign-up/email`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Local User',
        email: 'local@example.invalid',
        password: 'local-test-password-only',
      }),
    });
    expect(signedUp.status).toBe(200);
    const cookie = signedUp.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const headers = { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' };
    const created = await fetch(`${baseURL}/threads`, { method: 'POST', headers });
    expect(created.status).toBe(201);
    const thread = ThreadSchema.parse(await created.json());
    const accepted = await fetch(`${baseURL}/threads/${thread.id}/turns`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requestId: randomUUID(),
        input: { content: [{ type: 'text', text: 'Work' }] },
      }),
    });
    expect(accepted.status).toBe(202);
    const turn = TurnSchema.parse(await accepted.json());
    await expect
      .poll(async () => (await broker.queue.getJobs(['waiting'])).map((job) => job.data), {
        timeout: 5000,
      })
      .toEqual([{ turnId: turn.id }]);
    expect((await fixture.database.selectFrom('turns').selectAll().execute())[0]?.status).toBe(
      'accepted',
    );
    expect(await fixture.database.selectFrom('turn_attempts').selectAll().execute()).toEqual([]);
    await server.close();
    await server.finished;
    expect(broker.connection.status).toBe('ready');
  } finally {
    await server.close();
    await broker.dispose();
    await fixture.dispose();
  }
});
