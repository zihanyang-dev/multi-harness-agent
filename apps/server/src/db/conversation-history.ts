import type { Database } from '@multi-harness/database';
import type { DatabaseSchema } from '@multi-harness/database/schema';
import { type Turn, TurnSchema } from '@multi-harness/protocol/http';
import { type Selectable, sql } from 'kysely';

export async function getTurn(
  database: Database,
  options: { ownerId: string; turnId: string },
): Promise<Turn | undefined> {
  const row = await database
    .selectFrom('turns')
    .selectAll()
    .where('id', '=', options.turnId)
    .where('owner_id', '=', options.ownerId)
    .executeTakeFirst();
  return row === undefined ? undefined : toTurn(row);
}

/** Reads bounded, stable history; the cursor must itself belong to this authorized thread. */
export async function listTurns(
  database: Database,
  options: { ownerId: string; threadId: string; after?: string },
): Promise<{ turns: Turn[]; nextCursor: string | null } | undefined> {
  const { ownerId, threadId, after } = options;
  const thread = await database
    .selectFrom('threads')
    .select('id')
    .where('id', '=', threadId)
    .where('owner_id', '=', ownerId)
    .executeTakeFirst();
  if (thread === undefined) return;
  let query = database.selectFrom('turns').selectAll().where('thread_id', '=', threadId);
  if (after !== undefined) {
    const cursor = await database
      .selectFrom('turns')
      .select('id')
      .where('id', '=', after)
      .where('thread_id', '=', threadId)
      .executeTakeFirst();
    if (cursor === undefined) return;
    // Keep cursor precision in PostgreSQL; JS Date truncates its microseconds.
    query = query.where(sql<boolean>`(accepted_at, id) > (
      select accepted_at, id from turns where id = ${after}::uuid and thread_id = ${threadId}::uuid
    )`);
  }
  const rows = await query.orderBy('accepted_at').orderBy('id').limit(26).execute();
  const page = rows.slice(0, 25);
  return {
    turns: page.map(toTurn),
    nextCursor: rows.length > 25 ? (page.at(-1)?.id ?? null) : null,
  };
}

export function toTurn(row: Selectable<DatabaseSchema['turns']>): Turn {
  return TurnSchema.parse({
    id: row.id,
    threadId: row.thread_id,
    input: row.input_json,
    status: row.status,
    result: row.result_json,
    failureCode: row.failure_code,
    acceptedAt: row.accepted_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  });
}
