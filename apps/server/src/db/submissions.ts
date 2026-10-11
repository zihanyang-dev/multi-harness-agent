import { randomUUID } from 'node:crypto';
import type { Database } from '@multi-harness/database';
import type { Turn } from '@multi-harness/protocol/http';
import {
  captureSubmission,
  decideTurnReplay,
  type TurnSubmission,
} from '../conversation/submission.js';
import { toTurn } from './conversation-history.js';

export type AdmissionResult =
  | { kind: 'accepted'; turn: Turn; replayed: boolean }
  | { kind: 'conflict'; reason: 'request_conflict' | 'thread_busy' }
  | { kind: 'not_found' };

/** Commits the canonical request and dispatch intent together; no broker or model IO here. */
export async function acceptTurn(
  database: Database,
  options: TurnSubmission,
): Promise<AdmissionResult> {
  const submission = captureSubmission(options);
  const { ownerId, threadId, requestId, input } = submission;
  return database.transaction().execute(async (transaction) => {
    const thread = await transaction
      .selectFrom('threads')
      .select('id')
      .where('id', '=', threadId)
      .where('owner_id', '=', ownerId)
      .forUpdate()
      .executeTakeFirst();
    if (thread === undefined) return { kind: 'not_found' };

    const replay = () =>
      transaction
        .selectFrom('turns')
        .selectAll()
        .where('owner_id', '=', ownerId)
        .where('request_id', '=', requestId)
        .executeTakeFirst();
    const existing = await replay();
    if (existing !== undefined) {
      if (
        decideTurnReplay(submission, {
          threadId: existing.thread_id,
          input: existing.input_json,
        }) === 'conflict'
      )
        return { kind: 'conflict', reason: 'request_conflict' };
      return { kind: 'accepted', turn: toTurn(existing), replayed: true };
    }

    const admitted = await transaction
      .selectFrom('turns')
      .select('id')
      .where('thread_id', '=', threadId)
      .where('status', 'in', ['accepted', 'running', 'needs_reconciliation'])
      .executeTakeFirst();
    if (admitted !== undefined) return { kind: 'conflict', reason: 'thread_busy' };

    const row = await transaction
      .insertInto('turns')
      .values({
        id: randomUUID(),
        thread_id: threadId,
        owner_id: ownerId,
        request_id: requestId,
        input_json: input,
      })
      .onConflict((conflict) => conflict.columns(['owner_id', 'request_id']).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (row === undefined) {
      // A cross-thread contender can win this user's key. Read again at Read Committed.
      const winner = await replay();
      if (winner === undefined) throw new Error('Accepted request identity disappeared');
      if (
        decideTurnReplay(submission, { threadId: winner.thread_id, input: winner.input_json }) ===
        'conflict'
      )
        return { kind: 'conflict', reason: 'request_conflict' };
      return { kind: 'accepted', turn: toTurn(winner), replayed: true };
    }
    await transaction.insertInto('turn_outbox').values({ turn_id: row.id }).execute();
    return { kind: 'accepted', turn: toTurn(row), replayed: false };
  });
}
