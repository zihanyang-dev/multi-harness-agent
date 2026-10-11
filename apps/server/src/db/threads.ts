import { randomUUID } from 'node:crypto';
import type { Database } from '@multi-harness/database';
import { type PiBinding, PiBindingSchema } from '@multi-harness/protocol/execution';
import {
  type Thread,
  type ThreadList,
  ThreadSchema,
  ThreadSummarySchema,
  TurnInputSchema,
} from '@multi-harness/protocol/http';
import { sql } from 'kysely';

/** Creates an owner-scoped conversation with an immutable execution binding. */
export async function createThread(
  database: Database,
  options: { ownerId: string; binding: PiBinding },
): Promise<Thread> {
  const binding = PiBindingSchema.parse(options.binding);
  const row = await database
    .insertInto('threads')
    .values({
      id: randomUUID(),
      owner_id: options.ownerId,
      binding_json: binding,
    })
    .returning(['id', 'created_at', 'binding_json'])
    .executeTakeFirstOrThrow();
  return ThreadSchema.parse({
    id: row.id,
    harness: 'pi',
    tools: publicTools(row.binding_json),
    createdAt: row.created_at.toISOString(),
  });
}

/** Missing and foreign-owned threads are equally invisible. */
export async function getThread(
  database: Database,
  options: { ownerId: string; threadId: string },
): Promise<Thread | undefined> {
  const row = await database
    .selectFrom('threads')
    .select(['id', 'created_at', 'binding_json'])
    .where('id', '=', options.threadId)
    .where('owner_id', '=', options.ownerId)
    .executeTakeFirst();
  if (row === undefined) return;
  return ThreadSchema.parse({
    id: row.id,
    harness: 'pi',
    tools: publicTools(row.binding_json),
    createdAt: row.created_at.toISOString(),
  });
}

/** Lists owner-scoped summaries newest first; foreign and missing cursors are invisible. */
export async function listThreads(
  database: Database,
  options: { ownerId: string; after?: string },
): Promise<ThreadList | undefined> {
  const { ownerId, after } = options;
  if (after !== undefined) {
    const cursor = await database
      .selectFrom('threads')
      .select('id')
      .where('id', '=', after)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (cursor === undefined) return;
  }
  // Compare inside PostgreSQL: JS Date would discard cursor microseconds.
  const cursorPredicate =
    after === undefined
      ? sql`true`
      : sql`(thread.created_at, thread.id) < (
    select created_at, id from threads where id = ${after}::uuid and owner_id = ${ownerId}
  )`;
  const { rows } = await sql<{
    id: string;
    created_at: Date;
    input_json: unknown;
    binding_json: unknown;
  }>`
    select thread.id, thread.created_at, thread.binding_json,
      (select input_json from turns
       where thread_id = thread.id and owner_id = ${ownerId}
       order by accepted_at asc, id asc limit 1) as input_json
    from threads as thread
    where thread.owner_id = ${ownerId} and ${cursorPredicate}
    order by thread.created_at desc, thread.id desc
    limit 26
  `.execute(database);
  const page = rows.slice(0, 25);
  return {
    threads: page.map((row) =>
      ThreadSummarySchema.parse({
        id: row.id,
        harness: 'pi',
        tools: publicTools(row.binding_json),
        createdAt: row.created_at.toISOString(),
        title: previewTitle(row.input_json),
      }),
    ),
    nextCursor: rows.length > 25 ? (page.at(-1)?.id ?? null) : null,
  };
}

function previewTitle(input: unknown): string {
  const decoded = TurnInputSchema.safeParse(input);
  if (!decoded.success) return 'New conversation';
  const text = decoded.data.content
    .map((part) => part.text)
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
  // Avoid cutting an astral character in half at the UTF-16 display limit.
  return text.slice(0, 120).replace(/[\uD800-\uDBFF]$/u, '') || 'New conversation';
}

function publicTools(binding: unknown): 'web_search'[] {
  return PiBindingSchema.parse(binding).policy === 'web-search-v1' ? ['web_search'] : [];
}
