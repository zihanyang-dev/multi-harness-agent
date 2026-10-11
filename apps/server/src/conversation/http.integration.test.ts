import { randomUUID } from 'node:crypto';
import type { Thread, Turn } from '@multi-harness/protocol/http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../tests/integration/database.js';
import { createApp } from '../app.js';

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
    { type: 'text', text: 'First ' },
    { type: 'text', text: 'second' },
  ],
};
let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof createApp>;
beforeEach(async () => {
  fixture = await createTestDatabase();
  app = createApp({
    database: fixture.database,
    binding,
    trustedOrigin: 'http://localhost:3000',
    getOwnerId: async (request) => {
      const owner = request.headers.get('x-test-owner');
      return owner === 'alice' || owner === 'bob' ? owner : undefined;
    },
    handleAuth: async () => new Response('test auth'),
  });
});
afterEach(async () => {
  await fixture?.dispose();
});

function request(path: string, method = 'GET', body?: unknown, owner: string | null = 'alice') {
  return app.request(path, {
    method,
    headers: {
      ...(owner === null ? {} : { 'x-test-owner': owner }),
      'content-type': 'application/json',
      origin: 'http://localhost:3000',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function thread() {
  const response = await request('/threads', 'POST');
  expect(response.status).toBe(201);
  return (await response.json()) as Thread;
}
async function submit(threadId: string, requestId = randomUUID()) {
  const response = await request(`/threads/${threadId}/turns`, 'POST', { requestId, input });
  expect(response.status).toBe(202);
  return (await response.json()) as Turn;
}

it('mounts native auth GET and POST at root paths and keeps liveness independent', async () => {
  for (const method of ['GET', 'POST']) {
    const response = await app.request('/auth/get-session', { method });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('test auth');
  }
  expect((await app.request('/healthz')).status).toBe(200);
  expect((await request('/api/threads', 'POST')).status).toBe(404);
});

it('authenticates before validating or accessing scoped resources', async () => {
  for (const [path, method] of [
    ['/threads', 'POST'],
    ['/threads/not-a-uuid', 'GET'],
    ['/threads/not-a-uuid/turns', 'POST'],
    ['/threads/not-a-uuid/turns', 'GET'],
    ['/turns/not-a-uuid', 'GET'],
    ['/turns/not-a-uuid/cancel', 'POST'],
  ] as const) {
    expect((await request(path, method, undefined, null)).status).toBe(401);
  }
  expect(await fixture.database.selectFrom('threads').selectAll().execute()).toEqual([]);
});

it('persists acceptance and ordered input and replays without a second outbox entry', async () => {
  const created = await thread();
  expect(Object.keys(created).sort()).toEqual(['createdAt', 'harness', 'id', 'tools']);
  expect(created.tools).toEqual([]);
  const requestId = randomUUID();
  const accepted = await submit(created.id, requestId);
  expect(accepted).toMatchObject({ threadId: created.id, status: 'accepted', input });
  expect(accepted).not.toHaveProperty('ownerId');
  expect(accepted).not.toHaveProperty('nativeSessionId');
  expect(await (await request(`/threads/${created.id}`)).json()).toEqual(created);
  expect(await (await request(`/turns/${accepted.id}`)).json()).toEqual(accepted);
  const replay = await request(`/threads/${created.id}/turns`, 'POST', { requestId, input });
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(accepted);
  expect(await fixture.database.selectFrom('turns').selectAll().execute()).toHaveLength(1);
  expect(await fixture.database.selectFrom('turn_outbox').selectAll().execute()).toHaveLength(1);
});

it('never takes thread ownership or native execution options from a client body', async () => {
  const response = await request('/threads', 'POST', {
    ownerId: 'bob',
    binding: { provider: 'client' },
    nativeSessionId: 'client',
  });
  expect(response.status).toBe(201);
  const created = (await response.json()) as Thread;
  const row = await fixture.database
    .selectFrom('threads')
    .selectAll()
    .where('id', '=', created.id)
    .executeTakeFirstOrThrow();
  expect(row.owner_id).toBe('alice');
  expect(row.binding_json).toEqual(binding);
  expect(row.native_session_id).toBeNull();
});

it('distinguishes payload conflict from thread busy without mutating input', async () => {
  const created = await thread();
  const requestId = randomUUID();
  const accepted = await submit(created.id, requestId);
  const conflict = await request(`/threads/${created.id}/turns`, 'POST', {
    requestId,
    input: { content: [...input.content].reverse() },
  });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ code: 'request_conflict' });
  const busy = await request(`/threads/${created.id}/turns`, 'POST', {
    requestId: randomUUID(),
    input,
  });
  expect(busy.status).toBe(409);
  expect(await busy.json()).toEqual({ code: 'thread_busy' });
  expect(await (await request(`/turns/${accepted.id}`)).json()).toEqual(accepted);
});

it('makes foreign and missing resources equally invisible', async () => {
  const created = await thread();
  const accepted = await submit(created.id);
  for (const owner of ['alice', 'bob']) {
    const threadId = owner === 'alice' ? randomUUID() : created.id;
    const turnId = owner === 'alice' ? randomUUID() : accepted.id;
    for (const [path, method, body] of [
      [`/threads/${threadId}`, 'GET', undefined],
      [`/threads/${threadId}/turns`, 'GET', undefined],
      [`/threads/${threadId}/turns`, 'POST', { requestId: randomUUID(), input }],
      [`/turns/${turnId}`, 'GET', undefined],
      [`/turns/${turnId}/cancel`, 'POST', undefined],
    ] as const) {
      const response = await request(path, method, body, owner);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ code: 'not_found' });
    }
  }
});

it('rejects malformed IDs, cursors, JSON and non-text or extra submit fields', async () => {
  const created = await thread();
  for (const path of ['/threads/bad', '/turns/bad', `/threads/${created.id}/turns?after=bad`]) {
    expect((await request(path)).status).toBe(400);
  }
  for (const body of [
    {},
    { requestId: 'bad', input },
    { requestId: randomUUID(), input, ownerId: 'bob' },
    { requestId: randomUUID(), input: { content: [{ type: 'file', url: 'secret' }] } },
    { requestId: randomUUID(), input: { content: [] } },
  ]) {
    expect((await request(`/threads/${created.id}/turns`, 'POST', body)).status).toBe(400);
  }
  const malformed = await app.request(`/threads/${created.id}/turns`, {
    method: 'POST',
    headers: { 'x-test-owner': 'alice', origin: 'http://localhost:3000' },
    body: '{',
  });
  expect(malformed.status).toBe(400);
  expect(await fixture.database.selectFrom('turns').selectAll().execute()).toEqual([]);
});

it('limits streamed and declared bodies to 128 KiB', async () => {
  const created = await thread();
  const body = JSON.stringify({
    requestId: randomUUID(),
    input: { content: [{ type: 'text', text: 'x'.repeat(128 * 1024) }] },
  });
  for (const declared of [false, true]) {
    const response = await app.request(`/threads/${created.id}/turns`, {
      method: 'POST',
      headers: {
        'x-test-owner': 'alice',
        origin: 'http://localhost:3000',
        ...(declared ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
      },
      body,
    });
    expect(response.status).toBe(413);
  }
});

it('returns bounded history and validates cursor membership', async () => {
  const created = await thread();
  const turns: Turn[] = [];
  for (let index = 0; index < 26; index++) {
    const accepted = await submit(created.id);
    turns.push(accepted);
    expect((await request(`/turns/${accepted.id}/cancel`, 'POST')).status).toBe(200);
  }
  const page = (await (await request(`/threads/${created.id}/turns`)).json()) as {
    turns: Turn[];
    nextCursor: string | null;
  };
  expect(page.turns.map((turn: Turn) => turn.id)).toEqual(
    turns.slice(0, 25).map((turn) => turn.id),
  );
  expect(page.nextCursor).toBe(turns[24]?.id);
  const next = (await (
    await request(`/threads/${created.id}/turns?after=${page.nextCursor}`)
  ).json()) as { turns: Turn[]; nextCursor: string | null };
  expect(next.turns.map((turn: Turn) => turn.id)).toEqual([turns[25]?.id]);
  expect(next.nextCursor).toBeNull();
  expect((await request(`/threads/${created.id}/turns?after=${randomUUID()}`)).status).toBe(404);
});

it('records active cancellation intent without inventing a cancelled outcome', async () => {
  const created = await thread();
  const accepted = await submit(created.id);
  await fixture.database
    .updateTable('turns')
    .set({ status: 'running' })
    .where('id', '=', accepted.id)
    .execute();
  const response = await request(`/turns/${accepted.id}/cancel`, 'POST');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id: accepted.id, status: 'running' });
  const row = await fixture.database
    .selectFrom('turns')
    .selectAll()
    .where('id', '=', accepted.id)
    .executeTakeFirstOrThrow();
  expect(row.cancel_requested_at).toBeInstanceOf(Date);
  expect(row.finished_at).toBeNull();
});

it('keeps database failure details private and rolls acceptance back', async () => {
  const created = await thread();
  await fixture.pool.query(
    `create function reject_outbox() returns trigger language plpgsql as $$ begin raise exception 'private SQL diagnostic'; end $$; create trigger reject_outbox before insert on turn_outbox for each row execute function reject_outbox()`,
  );
  const response = await request(`/threads/${created.id}/turns`, 'POST', {
    requestId: randomUUID(),
    input,
  });
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ code: 'internal_error' });
  expect(await fixture.database.selectFrom('turns').selectAll().execute()).toEqual([]);
});

it('lists authenticated owner summaries without changing the thread detail contract', async () => {
  expect((await request('/threads?after=bad', 'GET', undefined, null)).status).toBe(401);
  expect((await request('/threads?after=bad')).status).toBe(400);
  const created = await thread();
  const foreign = await request('/threads', 'POST', undefined, 'bob');
  const foreignThread = (await foreign.json()) as Thread;
  await submit(created.id);
  const response = await request('/threads?ownerId=bob');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    threads: [{ ...created, title: 'First second' }],
    nextCursor: null,
  });
  expect(await (await request(`/threads/${created.id}`)).json()).toEqual(created);
  for (const after of [foreignThread.id, randomUUID()]) {
    const missing = await request(`/threads?after=${after}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ code: 'not_found' });
  }
});

it('returns bounded thread pages and private list failure responses', async () => {
  for (let index = 0; index < 26; index++) await thread();
  const response = await request('/threads');
  expect(response.status).toBe(200);
  const page = (await response.json()) as { threads: Thread[]; nextCursor: string };
  expect(page.threads).toHaveLength(25);
  expect(page.nextCursor).toBe(page.threads.at(-1)?.id);
  const next = await request(`/threads?after=${page.nextCursor}`);
  expect(next.status).toBe(200);
  const tail = (await next.json()) as { threads: Thread[]; nextCursor: null };
  expect(tail.threads).toHaveLength(1);
  expect(tail.nextCursor).toBeNull();
  expect(page.threads.map((thread) => thread.id)).not.toContain(tail.threads[0]?.id);
  await fixture.pool.query('drop table turn_outbox; drop table turn_attempts; drop table turns');
  const failure = await request('/threads');
  expect(failure.status).toBe(500);
  expect(await failure.json()).toEqual({ code: 'internal_error' });
});
