import { randomUUID } from 'node:crypto';
import type { Database } from '@multi-harness/database';
import type { DatabaseSchema } from '@multi-harness/database/schema';
import { type PiBinding, PiBindingSchema } from '@multi-harness/protocol/execution';
import {
  type Turn,
  type TurnInput,
  TurnInputSchema,
  type TurnResult,
  TurnResultSchema,
} from '@multi-harness/protocol/http';
import { sql, type Transaction } from 'kysely';

export interface ClaimedTurn {
  attemptId: string;
  turnId: string;
  threadId: string;
  input: TurnInput;
  binding: PiBinding;
  nativeSessionId: string | null;
}

export type TurnOutcome =
  | { status: 'completed' | 'cancelled'; result: TurnResult }
  | { status: 'failed'; result: null };
export type ReconciliationCode = Extract<Turn, { status: 'needs_reconciliation' }>['failureCode'];

/** Commits ownership before native invocation; queue retries never replace an existing claim. */
export async function claimTurn(
  database: Database,
  options: { turnId: string; binding: PiBinding },
): Promise<ClaimedTurn | undefined> {
  const turnId = options.turnId;
  const binding = PiBindingSchema.parse(options.binding);
  return database.transaction().execute(async (transaction) => {
    const locked = await lockTurn(transaction, { turnId });
    if (locked === undefined || locked.turn.status !== 'accepted') return;
    const { turn, thread } = locked;
    const admittedBinding = PiBindingSchema.safeParse(thread.binding_json);
    if (
      !admittedBinding.success ||
      JSON.stringify(binding) !== JSON.stringify(admittedBinding.data)
    ) {
      await transaction
        .updateTable('turns')
        .where('id', '=', turnId)
        .set({ status: 'needs_reconciliation', failure_code: 'binding_mismatch' })
        .execute();
      return;
    }
    const input = TurnInputSchema.safeParse(turn.input_json);
    if (!input.success) {
      await transaction
        .updateTable('turns')
        .where('id', '=', turnId)
        .set({ status: 'needs_reconciliation', failure_code: 'invalid_input' })
        .execute();
      return;
    }
    const attemptId = randomUUID();
    await transaction
      .insertInto('turn_attempts')
      .values({ id: attemptId, turn_id: turnId, binding_json: binding })
      .execute();
    await transaction
      .updateTable('turns')
      .where('id', '=', turnId)
      .set({ status: 'running' })
      .execute();
    return {
      attemptId,
      turnId,
      threadId: thread.id,
      input: input.data,
      binding: admittedBinding.data,
      nativeSessionId: thread.native_session_id,
    };
  });
}

/** Records allocation on the attempt; only a settled invocation may advance thread history. */
export async function recordNativeSession(
  database: Database,
  options: { turnId: string; attemptId: string; nativeSessionId: string },
): Promise<boolean> {
  const identity = { ...options };
  return database.transaction().execute(async (transaction) => {
    const locked = await lockTurn(transaction, identity);
    if (locked === undefined || locked.turn.status !== 'running') return false;
    const attempt = await transaction
      .selectFrom('turn_attempts')
      .select('native_session_id')
      .where('turn_id', '=', identity.turnId)
      .where('id', '=', identity.attemptId)
      .forUpdate()
      .executeTakeFirst();
    if (
      attempt === undefined ||
      (attempt.native_session_id !== null && attempt.native_session_id !== identity.nativeSessionId)
    )
      return false;
    await transaction
      .updateTable('turn_attempts')
      .where('id', '=', identity.attemptId)
      .set({ native_session_id: identity.nativeSessionId })
      .execute();
    return true;
  });
}

/** Called after owned invocation and transferred cleanup join; atomically commits result and stop. */
export async function finishTurn(
  database: Database,
  options: { turnId: string; attemptId: string; outcome: TurnOutcome; nativeSessionId?: string },
): Promise<boolean> {
  const { turnId, attemptId, nativeSessionId } = options;
  const status = options.outcome.status;
  const result = status === 'failed' ? null : TurnResultSchema.parse(options.outcome.result);
  return database.transaction().execute(async (transaction) => {
    const locked = await lockTurn(transaction, { turnId });
    if (locked === undefined || locked.turn.status !== 'running') return false;
    const attempt = await transaction
      .selectFrom('turn_attempts')
      .selectAll()
      .where('turn_id', '=', turnId)
      .where('id', '=', attemptId)
      .forUpdate()
      .executeTakeFirst();
    if (attempt === undefined || attempt.stopped_at !== null) return false;
    if (nativeSessionId !== undefined && nativeSessionId !== attempt.native_session_id)
      return false;

    await transaction
      .updateTable('turns')
      .where('id', '=', turnId)
      .set({
        status,
        result_json: result,
        failure_code: status === 'failed' ? 'execution_failed' : null,
        finished_at: sql<Date>`now()`,
      })
      .execute();
    await transaction
      .updateTable('turn_attempts')
      .where('id', '=', attemptId)
      .set({ stopped_at: sql<Date>`now()` })
      .execute();
    if (nativeSessionId !== undefined) {
      await transaction
        .updateTable('threads')
        .where('id', '=', locked.thread.id)
        .set({ native_session_id: nativeSessionId })
        .execute();
    }
    return true;
  });
}

/** Uncertainty blocks admission; this does not declare the native writer stopped or grant takeover. */
export async function markReconciliation(
  database: Database,
  options: { turnId: string; attemptId: string; code: ReconciliationCode },
): Promise<void> {
  const identity = { ...options };
  await database.transaction().execute(async (transaction) => {
    const locked = await lockTurn(transaction, identity);
    if (locked === undefined || locked.turn.status !== 'running') return;
    const attempt = await transaction
      .selectFrom('turn_attempts')
      .select('id')
      .where('turn_id', '=', identity.turnId)
      .where('id', '=', identity.attemptId)
      .forUpdate()
      .executeTakeFirst();
    if (attempt === undefined) return;
    await transaction
      .updateTable('turns')
      .where('id', '=', identity.turnId)
      .set({ status: 'needs_reconciliation', failure_code: identity.code })
      .execute();
  });
}

/** Losing the persisted owner is an execution fault, not an absent cancellation request. */
export async function isCancellationRequested(
  database: Database,
  options: { turnId: string; attemptId: string },
): Promise<boolean> {
  const row = await database
    .selectFrom('turns')
    .innerJoin('turn_attempts', 'turn_attempts.turn_id', 'turns.id')
    .select(['turns.status', 'turns.cancel_requested_at'])
    .where('turns.id', '=', options.turnId)
    .where('turn_attempts.id', '=', options.attemptId)
    .executeTakeFirst();
  if (row === undefined || row.status !== 'running')
    throw new Error('Turn execution ownership changed');
  return row.cancel_requested_at !== null;
}

/** Locks the trusted accepted reference in Thread → Turn order; no product authorization here. */
async function lockTurn(transaction: Transaction<DatabaseSchema>, options: { turnId: string }) {
  const { turnId } = options;
  const reference = await transaction
    .selectFrom('turns')
    .select('thread_id')
    .where('id', '=', turnId)
    .executeTakeFirst();
  if (reference === undefined) return;

  const thread = await transaction
    .selectFrom('threads')
    .selectAll()
    .where('id', '=', reference.thread_id)
    .forUpdate()
    .executeTakeFirst();
  if (thread === undefined) return;

  const turn = await transaction
    .selectFrom('turns')
    .selectAll()
    .where('id', '=', turnId)
    .forUpdate()
    .executeTakeFirst();
  if (turn === undefined) return;
  return { thread, turn };
}
