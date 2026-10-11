import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { turnActivityKey } from '@multi-harness/protocol/execution';
import { ThreadSchema, type Turn, TurnSchema } from '@multi-harness/protocol/http';
import { Redis } from 'ioredis';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDatabase } from '../../../../tests/integration/database.js';
import { createApp } from '../app.js';

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let redis: Redis;
let redisURL: string;
let app: ReturnType<typeof createApp>;
let shutdown: AbortController;
let prefix: string;
let revoked: boolean;
let sessionOwner: string | undefined;
const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
const binding = {
  harness: 'pi',
  sdkVersion: '1.1.0',
  provider: 'faux',
  model: 'faux',
  policy: 'text-v1',
  storageId: 'test',
} as const;
beforeEach(async () => {
  fixture = await createTestDatabase();
  const url = process.env.TEST_REDIS_URL;
  if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
    throw new Error('Loopback TEST_REDIS_URL required');
  redisURL = url;
  redis = new Redis(url, { maxRetriesPerRequest: 1, commandTimeout: 2000 });
  await redis.ping();
  prefix = `activity-test:${randomUUID()}`;
  shutdown = new AbortController();
  revoked = false;
  sessionOwner = undefined;
  app = createApp({
    database: fixture.database,
    binding,
    trustedOrigin: 'http://localhost',
    getOwnerId: async (req) =>
      revoked ? undefined : (sessionOwner ?? req.headers.get('x-owner') ?? undefined),
    handleAuth: async () => new Response(),
    activity: { connection: redis, prefix, shutdown: shutdown.signal },
  });
});
afterEach(async () => {
  shutdown?.abort();
  await Promise.all(readers.splice(0).map((reader) => reader.cancel()));
  if (redis) {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  }
  await fixture?.dispose();
});
function request(path: string, owner = 'alice', extra: Record<string, string> = {}) {
  return app.request(path, { headers: { 'x-owner': owner, ...extra } });
}
async function accepted(): Promise<Turn> {
  const thread = await app.request('/threads', {
    method: 'POST',
    headers: { 'x-owner': 'alice', origin: 'http://localhost' },
  });
  const { id } = ThreadSchema.parse(await thread.json());
  const turn = await app.request(`/threads/${id}/turns`, {
    method: 'POST',
    headers: { 'x-owner': 'alice', origin: 'http://localhost', 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: randomUUID(),
      input: { content: [{ type: 'text', text: 'hello' }] },
    }),
  });
  return TurnSchema.parse(await turn.json());
}
async function observe(turn: Turn, cursor?: string) {
  const response = await request(
    `/turns/${turn.id}/events`,
    'alice',
    cursor ? { 'Last-Event-ID': cursor } : {},
  );
  expect(response.status).toBe(200);
  if (response.body === null) throw new Error('Missing SSE body');
  const reader = response.body.getReader();
  readers.push(reader);
  let buffer = '';
  return {
    reader,
    async next() {
      while (!buffer.includes('\n\n')) {
        const chunk = await reader.read();
        if (chunk.done) return undefined;
        buffer += new TextDecoder().decode(chunk.value);
      }
      const end = buffer.indexOf('\n\n');
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      return frame;
    },
  };
}
function append(turnId: string, id: string, delta = 'live') {
  return redis.xadd(
    turnActivityKey(prefix, turnId),
    id,
    'activity',
    JSON.stringify({ turnId, event: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta } }),
  );
}
async function nextEvent(observer: Awaited<ReturnType<typeof observe>>, name: string) {
  for (let i = 0; i < 30; i++) {
    const frame = await observer.next();
    if (frame === undefined || frame.includes(`event: ${name}\n`)) return frame;
  }
  throw new Error('Event not received');
}
it('authenticates and scopes before any Redis, validating IDs and cursors', async () => {
  const turn = await accepted();
  redis.disconnect();
  expect((await app.request('/turns/bad/events')).status).toBe(401);
  expect((await request(`/turns/${turn.id}/events`, 'bob')).status).toBe(404);
  expect((await request('/turns/bad/events')).status).toBe(400);
  for (const cursor of ['bad', '1-2-3', '18446744073709551616-0', `${'9'.repeat(30)}-0`]) {
    expect(
      (await request(`/turns/${turn.id}/events`, 'alice', { 'Last-Event-ID': cursor })).status,
    ).toBe(400);
  }
  redis = new Redis(redisURL, { maxRetriesPerRequest: 1 });
});
it('streams live before formal PG result, replays without duplicating the cursor, and disconnect never cancels', async () => {
  const turn = await accepted();
  await append(turn.id, '9-0', 'first');
  await append(turn.id, '10-0', 'second');
  const observer = await observe(turn, '9-0');
  expect(await nextEvent(observer, 'turn')).toContain('"status":"accepted"');
  const frame = await nextEvent(observer, 'activity');
  expect(frame).toContain('id: 10-0');
  expect(frame).not.toContain('first');
  await append(turn.id, '11-0', 'live');
  expect(await nextEvent(observer, 'activity')).toContain('live');
  await observer.reader.cancel();
  const row = await fixture.database
    .selectFrom('turns')
    .selectAll()
    .where('id', '=', turn.id)
    .executeTakeFirstOrThrow();
  expect(row.status).toBe('accepted');
  expect(row.cancel_requested_at).toBeNull();
});
it('reports explicit producer observation failure without treating it as malformed activity or completion', async () => {
  const turn = await accepted();
  await redis.xadd(turnActivityKey(prefix, turn.id), '1-0', 'gap', 'activity_unavailable');
  await append(turn.id, '2-0', 'later activity');
  const observer = await observe(turn);
  expect(await nextEvent(observer, 'gap')).toContain('activity_unavailable');
  expect(await nextEvent(observer, 'activity')).toContain('later activity');
  expect(
    (
      await fixture.database
        .selectFrom('turns')
        .select('status')
        .where('id', '=', turn.id)
        .executeTakeFirstOrThrow()
    ).status,
  ).toBe('accepted');
});

it('reports retention and future cursor gaps and replays the first retained event', async () => {
  const turn = await accepted();
  await append(turn.id, '9-0');
  await append(turn.id, '10-0');
  await redis.xtrim(turnActivityKey(prefix, turn.id), 'MAXLEN', 1);
  for (const cursor of ['9-0', '999-0']) {
    const observer = await observe(turn, cursor);
    expect(await nextEvent(observer, 'gap')).toContain('activity_gap');
    expect(await nextEvent(observer, 'activity')).toContain('id: 10-0');
    await observer.reader.cancel();
  }
});
it('reports fresh retention loss before replaying the retained suffix', async () => {
  const turn = await accepted();
  await append(turn.id, '9-0', 'trimmed');
  await append(turn.id, '10-0', 'retained');
  await redis.xtrim(turnActivityKey(prefix, turn.id), 'MAXLEN', 1);
  const observer = await observe(turn);
  expect(await observer.next()).toContain('event: turn');
  expect(await observer.next()).toContain('data: {"code":"activity_gap"}');
  expect(await observer.next()).toContain('id: 10-0');
});

it('detects retention loss when trimming immediately before the replay read', async () => {
  const turn = await accepted();
  await append(turn.id, '9-0', 'cursor');
  await append(turn.id, '10-0', 'trimmed');
  await append(turn.id, '11-0', 'retained');
  const trimmer = new Redis(redisURL, { maxRetriesPerRequest: 1 });
  await trimmer.ping();
  const sendCommand = redis.sendCommand.bind(redis);
  let trimmed = false;
  const spy = vi.spyOn(redis, 'sendCommand').mockImplementation((command, ...args) => {
    if (!trimmed && (command.name === 'xread' || command.name === 'eval')) {
      trimmed = true;
      return trimmer
        .xtrim(turnActivityKey(prefix, turn.id), 'MAXLEN', 1)
        .then(() => sendCommand(command, ...args));
    }
    return sendCommand(command, ...args);
  });
  try {
    const observer = await observe(turn, '9-0');
    expect(await observer.next()).toContain('event: turn');
    expect(await observer.next()).toContain('data: {"code":"activity_gap"}');
    expect(await observer.next()).toContain('id: 11-0');
    await observer.reader.cancel();
  } finally {
    spy.mockRestore();
    trimmer.disconnect();
  }
});

it('rejects corrupt, foreign and native payloads without leaking them', async () => {
  const turn = await accepted();
  const key = turnActivityKey(prefix, turn.id);
  await redis.xadd(key, '1-0', 'activity', 'secret-corrupt');
  await redis.xadd(
    key,
    '2-0',
    'activity',
    JSON.stringify({
      turnId: randomUUID(),
      event: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'foreign-secret' },
    }),
  );
  await redis.xadd(
    key,
    '3-0',
    'activity',
    JSON.stringify({ turnId: turn.id, event: { type: 'RUN_FINISHED', rawEvent: 'native-secret' } }),
  );
  await append(turn.id, '4-0', 'safe');
  const observer = await observe(turn);
  for (let i = 0; i < 3; i++) expect(await nextEvent(observer, 'gap')).toContain('activity_gap');
  expect(await nextEvent(observer, 'activity')).toContain('safe');
  expect(TurnSchema.parse(await (await request(`/turns/${turn.id}`)).json()).status).toBe(
    'accepted',
  );
});
it('revalidates native auth and closes on revoked sessions', async () => {
  const observer = await observe(await accepted());
  await nextEvent(observer, 'turn');
  revoked = true;
  expect(await nextEvent(observer, 'turn')).toBeUndefined();
});
it('uses terminal PG authority and drains on root shutdown', async () => {
  const turn = await accepted();
  const observer = await observe(turn);
  await nextEvent(observer, 'turn');
  await fixture.database
    .updateTable('turns')
    .set({ status: 'failed', failure_code: 'execution_failed', finished_at: new Date() })
    .where('id', '=', turn.id)
    .execute();
  expect(await nextEvent(observer, 'turn')).toContain('"status":"failed"');
  expect(await observer.next()).toBeUndefined();
  const terminal = await observe(turn);
  expect(await nextEvent(terminal, 'turn')).toContain('"status":"failed"');
  expect(await terminal.next()).toBeUndefined();
  const other = await observe(await accepted());
  await nextEvent(other, 'turn');
  shutdown.abort();
  expect(await nextEvent(other, 'turn')).toBeUndefined();
});

it('terminates when the native session changes owner', async () => {
  const observer = await observe(await accepted());
  await nextEvent(observer, 'turn');
  sessionOwner = 'bob';
  expect(await nextEvent(observer, 'turn')).toBeUndefined();
});

it('reports unavailable activity without exposing Redis diagnostics', async () => {
  const turn = await accepted();
  const withoutActivity = createApp({
    database: fixture.database,
    binding,
    trustedOrigin: 'http://localhost',
    getOwnerId: async () => 'alice',
    handleAuth: async () => new Response(),
  });
  const absent = await withoutActivity.request(`/turns/${turn.id}/events`);
  expect(absent.status).toBe(503);
  expect(await absent.json()).toEqual({ code: 'activity_unavailable' });
  redis.disconnect();
  const observer = await observe(turn);
  expect(await nextEvent(observer, 'gap')).toContain('data: {"code":"activity_unavailable"}');
  expect(await observer.next()).toBeUndefined();
  redis = new Redis(redisURL, { maxRetriesPerRequest: 1 });
});

it('drains an actual HTTP SSE connection on shutdown without an observer registry', async () => {
  const turn = await accepted();
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  const response = await fetch(`http://127.0.0.1:${address.port}/turns/${turn.id}/events`, {
    headers: { 'x-owner': 'alice' },
  });
  if (response.body === null) throw new Error('Missing SSE body');
  const reader = response.body.getReader();
  readers.push(reader);
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: turn');
  shutdown.abort();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  while (!(await reader.read()).done) {
    /* Drain any heartbeat already sent. */
  }
});

it('sends an authoritative reconciliation snapshot without an SSE id and closes', async () => {
  const turn = await accepted();
  await fixture.database
    .updateTable('turns')
    .set({ status: 'needs_reconciliation', failure_code: 'execution_unknown' })
    .where('id', '=', turn.id)
    .execute();
  const observer = await observe(turn);
  const snapshot = await nextEvent(observer, 'turn');
  expect(snapshot).toContain('"status":"needs_reconciliation"');
  expect(snapshot).not.toMatch(/^id:/m);
  expect(await observer.next()).toBeUndefined();
});
