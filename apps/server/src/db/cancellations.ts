import type { Database } from '@multi-harness/database';
import type { Turn } from '@multi-harness/protocol/http';
import { sql } from 'kysely';
import { toTurn } from './conversation-history.js';

/** Unclaimed work can stop transactionally; active work records intent, not fictional shutdown. */
export async function requestCancellation(
  database: Database,
  options: { ownerId: string; turnId: string },
): Promise<Turn | undefined> {
  const { turnId, ownerId } = options;
  return database.transaction().execute(async (transaction) => {
    // Authorize first, then lock Thread before Turn in the same order as execution.
    const reference = await transaction
      .selectFrom('turns')
      .select('thread_id')
      .where('id', '=', turnId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (reference === undefined) return;
    const thread = await transaction
      .selectFrom('threads')
      .select('id')
      .where('id', '=', reference.thread_id)
      .where('owner_id', '=', ownerId)
      .forUpdate()
      .executeTakeFirst();
    if (thread === undefined) return;
    const turn = await transaction
      .selectFrom('turns')
      .selectAll()
      .where('id', '=', turnId)
      .where('owner_id', '=', ownerId)
      .forUpdate()
      .executeTakeFirst();
    if (turn === undefined) return;
    if (['completed', 'cancelled', 'failed'].includes(turn.status)) return toTurn(turn);
    let update = transaction
      .updateTable('turns')
      .where('id', '=', turn.id)
      .set({ cancel_requested_at: turn.cancel_requested_at ?? sql<Date>`now()` });
    if (turn.status === 'accepted') {
      update = update.set({
        status: 'cancelled',
        result_json: { messages: [] },
        finished_at: sql<Date>`now()`,
      });
    }
    return toTurn(await update.returningAll().executeTakeFirstOrThrow());
  });
}
