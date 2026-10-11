import type { Database } from '@multi-harness/database';
import { sql } from 'kysely';

export interface TurnDelivery {
  turnId: string;
  generation: number;
}

/** Reserves a bounded notification batch, not native execution. Never locks across broker IO. */
export async function reserveDeliveries(
  database: Database,
  options: { limit: number; redeliveryDelayMs: number },
): Promise<TurnDelivery[]> {
  const { limit, redeliveryDelayMs } = options;
  return database.transaction().execute(async (transaction) => {
    const rows = await transaction
      .selectFrom('turn_outbox')
      .innerJoin('turns', 'turns.id', 'turn_outbox.turn_id')
      .select(['turn_outbox.turn_id', 'turn_outbox.generation'])
      .where('turns.status', '=', 'accepted')
      .where('turn_outbox.next_delivery_at', '<=', sql<Date>`now()`)
      .orderBy('turn_outbox.next_delivery_at')
      .orderBy('turn_outbox.turn_id')
      .limit(limit)
      .forUpdate('turn_outbox')
      .skipLocked()
      .execute();
    if (rows.length === 0) return [];
    await transaction
      .updateTable('turn_outbox')
      .where(
        'turn_id',
        'in',
        rows.map((row) => row.turn_id),
      )
      .set({ next_delivery_at: sql<Date>`now() + ${redeliveryDelayMs} * interval '1 millisecond'` })
      .execute();
    return rows.map((row) => ({ turnId: row.turn_id, generation: row.generation }));
  });
}

/** Enqueue telemetry is not worker acceptance; previously published, unclaimed turns stay eligible. */
export async function notePublished(database: Database, delivery: TurnDelivery): Promise<void> {
  const { turnId, generation } = delivery;
  await database
    .updateTable('turn_outbox')
    .where('turn_id', '=', turnId)
    .where('generation', '=', generation)
    .set({ last_published_at: sql<Date>`now()` })
    .execute();
}

/** A retained terminal notification must not suppress a new wakeup for still-unclaimed work. */
export async function advanceDelivery(
  database: Database,
  delivery: TurnDelivery,
): Promise<TurnDelivery | undefined> {
  const { turnId, generation } = delivery;
  const row = await database
    .updateTable('turn_outbox')
    .where('turn_id', '=', turnId)
    .where('generation', '=', generation)
    .where((expression) =>
      expression.exists(
        expression
          .selectFrom('turns')
          .select('id')
          .where('id', '=', turnId)
          .where('status', '=', 'accepted'),
      ),
    )
    .set({ generation: sql<number>`generation + 1`, next_delivery_at: sql<Date>`now()` })
    .returning('generation')
    .executeTakeFirst();
  return row === undefined ? undefined : { turnId, generation: row.generation };
}
