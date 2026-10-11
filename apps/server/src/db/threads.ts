import { randomUUID } from 'node:crypto';
import type { Database } from '@multi-harness/database';
import type { PiBinding } from '@multi-harness/protocol/execution';
import { type Thread, ThreadSchema } from '@multi-harness/protocol/http';

/** Creates an owner-scoped conversation with an immutable execution binding. */
export async function createThread(
  database: Database,
  options: { ownerId: string; binding: PiBinding },
): Promise<Thread> {
  const { binding } = options;
  const row = await database
    .insertInto('threads')
    .values({
      id: randomUUID(),
      owner_id: options.ownerId,
      binding_json: binding,
    })
    .returning(['id', 'created_at'])
    .executeTakeFirstOrThrow();
  return { id: row.id, harness: binding.harness, createdAt: row.created_at.toISOString() };
}

/** Missing and foreign-owned threads are equally invisible. */
export async function getThread(
  database: Database,
  options: { ownerId: string; threadId: string },
): Promise<Thread | undefined> {
  const row = await database
    .selectFrom('threads')
    .select(['id', 'created_at'])
    .where('id', '=', options.threadId)
    .where('owner_id', '=', options.ownerId)
    .executeTakeFirst();
  if (row === undefined) return;
  return ThreadSchema.parse({ id: row.id, harness: 'pi', createdAt: row.created_at.toISOString() });
}
