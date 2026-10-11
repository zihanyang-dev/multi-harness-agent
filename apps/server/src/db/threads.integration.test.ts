import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../tests/integration/database.js';
import { createThread, listThreads } from './threads.js';

const binding = {
  harness: 'pi',
  sdkVersion: '1.1.0',
  provider: 'faux',
  model: 'faux',
  policy: 'text-v1',
  storageId: 'test-volume',
} as const;
let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
beforeEach(async () => {
  fixture = await createTestDatabase();
});
afterEach(async () => {
  await fixture?.dispose();
});

it('pages newest-first with UUID ties and preserves PostgreSQL microsecond cursor precision', async () => {
  const ids = Array.from(
    { length: 27 },
    (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  );
  for (const id of ids) {
    await fixture.pool.query(
      `insert into threads (id, owner_id, binding_json, created_at)
       values ($1, 'alice', $2, '2026-10-11T12:00:00.123456Z')`,
      [id, binding],
    );
  }
  const newest = await createThread(fixture.database, { ownerId: 'alice', binding });
  await fixture.pool.query(
    `update threads set created_at = '2026-10-11T12:00:00.123457Z' where id = $1`,
    [newest.id],
  );
  await createThread(fixture.database, { ownerId: 'bob', binding });
  const first = await listThreads(fixture.database, { ownerId: 'alice' });
  expect(first?.threads.map((thread) => thread.id)).toEqual([
    newest.id,
    ...ids.slice().reverse().slice(0, 24),
  ]);
  expect(first?.nextCursor).toBe(ids[3]);
  const second = await listThreads(fixture.database, { ownerId: 'alice', after: ids[3] ?? '' });
  expect(second?.threads.map((thread) => thread.id)).toEqual(ids.slice(0, 3).reverse());
  expect(second?.nextCursor).toBeNull();
  const precise = await listThreads(fixture.database, { ownerId: 'alice', after: newest.id });
  expect(precise?.threads.map((thread) => thread.id)).toEqual(ids.slice().reverse().slice(0, 25));
});

it('hides foreign and missing cursors and returns an empty owner page', async () => {
  const foreign = await createThread(fixture.database, { ownerId: 'bob', binding });
  expect(await listThreads(fixture.database, { ownerId: 'alice' })).toEqual({
    threads: [],
    nextCursor: null,
  });
  for (const after of [foreign.id, randomUUID()]) {
    expect(await listThreads(fixture.database, { ownerId: 'alice', after })).toBeUndefined();
  }
});

it('decodes only the first ordered accepted input into a bounded display preview', async () => {
  const created = await createThread(fixture.database, { ownerId: 'alice', binding });
  const firstId = '00000000-0000-4000-8000-000000000001';
  const secondId = '00000000-0000-4000-8000-000000000002';
  for (const [id, text] of [
    [secondId, 'Later'],
    [firstId, '  First\n'],
  ] as const) {
    await fixture.pool.query(
      `insert into turns (id, thread_id, owner_id, request_id, input_json, status, finished_at, failure_code, accepted_at)
       values ($1, $2, 'alice', $3, $4, 'failed', now(), 'execution_failed', '2026-10-11T12:00:00.123456Z')`,
      [
        id,
        created.id,
        randomUUID(),
        {
          content: [
            { type: 'text', text },
            { type: 'text', text: 'second  ' },
          ],
        },
      ],
    );
  }
  const read = async () => (await listThreads(fixture.database, { ownerId: 'alice' }))?.threads[0];
  expect(await read()).toEqual({ ...created, title: 'First second' });
  for (const input of [
    {},
    { content: [] },
    { content: [{ type: 'text', text: '  ' }] },
    { content: [{ type: 'file', text: 'private' }] },
  ]) {
    await fixture.database
      .updateTable('turns')
      .set({ input_json: input })
      .where('id', '=', firstId)
      .execute();
    expect((await read())?.title).toBe('New conversation');
  }
  await fixture.database
    .updateTable('turns')
    .set({ input_json: { content: [{ type: 'text', text: `${'x'.repeat(119)}😀tail` }] } })
    .where('id', '=', firstId)
    .execute();
  expect((await read())?.title).toBe('x'.repeat(119));
});

it('reports tools from the authorized stored policy, including older text-only conversations', async () => {
  const search = await createThread(fixture.database, {
    ownerId: 'alice',
    binding: { ...binding, policy: 'web-search-v1' },
  });
  const text = await createThread(fixture.database, { ownerId: 'alice', binding });
  expect(search.tools).toEqual(['web_search']);
  expect(text.tools).toEqual([]);
  const { getThread } = await import('./threads.js');
  expect(
    (await getThread(fixture.database, { ownerId: 'alice', threadId: search.id }))?.tools,
  ).toEqual(['web_search']);
  expect(
    await getThread(fixture.database, { ownerId: 'bob', threadId: search.id }),
  ).toBeUndefined();
  const page = await listThreads(fixture.database, { ownerId: 'alice' });
  expect(page?.threads.find((thread) => thread.id === search.id)?.tools).toEqual(['web_search']);
  expect(page?.threads.find((thread) => thread.id === text.id)?.tools).toEqual([]);
  expect(JSON.stringify(page)).not.toContain('storageId');
});
