import { setTimeout as delay } from 'node:timers/promises';
import type { Database } from '@multi-harness/database';
import type { HarnessRun, HarnessSession, HarnessTurnResult } from '@multi-harness/harness';
import type { TurnResult } from '@multi-harness/protocol/http';
import type { PiTurnHost } from '../contract.js';
import {
  type ClaimedTurn,
  claimTurn,
  finishTurn,
  isCancellationRequested,
  markReconciliation,
  type ReconciliationCode,
  recordNativeSession,
  type TurnOutcome,
} from './db/turns.js';

type TurnExecution =
  | { kind: 'settled'; outcome: TurnOutcome; nativeSessionId?: string }
  | { kind: 'uncertain'; code: ReconciliationCode };

/** Claims once, joins native execution and cleanup, then publishes a fenced formal result. */
export async function executeTurn(
  database: Database,
  options: { turnId: string; host: PiTurnHost; signal: AbortSignal; maxRunMs: number },
): Promise<void> {
  const { turnId, host, signal, maxRunMs } = options;
  if (!Number.isSafeInteger(maxRunMs) || maxRunMs <= 0 || maxRunMs > 2_147_483_647)
    throw new Error('invalid_run_deadline');
  if (signal.aborted) return;

  const deadline = performance.now() + maxRunMs;
  let claim: ClaimedTurn | undefined;
  try {
    claim = await claimTurn(database, { turnId, binding: host.binding });
  } catch {
    throw new Error('claim_unknown');
  }
  if (claim === undefined) return;

  const identity = { turnId, attemptId: claim.attemptId };
  let session: HarnessSession | undefined;
  let execution: TurnExecution;
  try {
    session = await host.openSession({
      threadId: claim.threadId,
      ...(claim.nativeSessionId === null ? {} : { nativeSessionId: claim.nativeSessionId }),
    });
    execution = await invokeTurn(database, claim, session, { shutdown: signal, deadline });
  } catch {
    execution = { kind: 'uncertain', code: 'execution_unknown' };
  }

  if (session !== undefined) {
    try {
      await session.dispose();
    } catch {
      execution = { kind: 'uncertain', code: 'cleanup_failed' };
    }
  }
  if (execution.kind === 'uncertain') {
    await reconcileTurn(database, identity, execution.code);
    return;
  }

  let committed = false;
  try {
    committed = await finishTurn(database, {
      ...identity,
      outcome: execution.outcome,
      ...(execution.nativeSessionId === undefined
        ? {}
        : { nativeSessionId: execution.nativeSessionId }),
    });
  } catch {
    // A lost commit response remains unknown, even after a settled native receipt.
  }
  if (committed) return;
  await reconcileTurn(database, identity, 'result_commit_unknown');
  throw new Error('result_commit_unknown');
}

async function invokeTurn(
  database: Database,
  claim: ClaimedTurn,
  session: HarnessSession,
  options: { shutdown: AbortSignal; deadline: number },
): Promise<TurnExecution> {
  const { shutdown, deadline } = options;
  const identity = { turnId: claim.turnId, attemptId: claim.attemptId };
  const recorded = await recordNativeSession(database, {
    ...identity,
    nativeSessionId: session.nativeSessionId,
  });
  if (!recorded) throw new Error('attempt_owner_changed');

  const cancelled = await isCancellationRequested(database, identity);
  if (cancelled || shutdown.aborted || performance.now() >= deadline) {
    // Allocation alone does not advance Thread history: there was no native invocation.
    return { kind: 'settled', outcome: { status: 'cancelled', result: { messages: [] } } };
  }

  const run = await session.run(claim.input);
  const stop = new AbortController();
  const [receipt, control] = await Promise.allSettled([
    run.result.finally(() => stop.abort()),
    monitorControl(database, identity, run, { shutdown, stop: stop.signal, deadline }),
  ]);
  if (receipt.status === 'fulfilled') {
    const result = receipt.value;
    if (result.status === 'paused') return { kind: 'uncertain', code: 'unsupported_pause' };
    if (control.status === 'rejected') return { kind: 'uncertain', code: 'execution_unknown' };
    const outcome: TurnOutcome = {
      status: result.status,
      result: { messages: publicText(result) },
    };
    return { kind: 'settled', outcome, nativeSessionId: session.nativeSessionId };
  }
  if (control.status === 'rejected' || !isNativeFailure(receipt.reason))
    return { kind: 'uncertain', code: 'execution_unknown' };
  return {
    kind: 'settled',
    outcome: { status: 'failed', result: null },
    nativeSessionId: session.nativeSessionId,
  };
}

/** Joins control reads, timer wakeups and the cooperative interrupt request. */
async function monitorControl(
  database: Database,
  identity: { turnId: string; attemptId: string },
  run: HarnessRun,
  options: { shutdown: AbortSignal; stop: AbortSignal; deadline: number },
): Promise<void> {
  const { shutdown, stop, deadline } = options;
  const wake = AbortSignal.any([shutdown, stop]);
  let controlFailed = false;
  try {
    while (true) {
      if (stop.aborted) return;
      const cancelled = await isCancellationRequested(database, identity);
      if (stop.aborted) return;
      if (cancelled || shutdown.aborted || performance.now() >= deadline) break;
      try {
        await delay(Math.max(1, Math.min(100, deadline - performance.now())), undefined, {
          signal: wake,
        });
      } catch (error) {
        if (!wake.aborted) throw error;
      }
    }
  } catch {
    controlFailed = true;
  }

  await run.interrupt();
  if (controlFailed) throw new Error('execution_control_unknown');
}

async function reconcileTurn(
  database: Database,
  identity: { turnId: string; attemptId: string },
  code: ReconciliationCode,
): Promise<void> {
  try {
    await markReconciliation(database, { ...identity, code });
  } catch {
    throw new Error(code === 'result_commit_unknown' ? code : 'reconciliation_unknown');
  }
}

function publicText(receipt: HarnessTurnResult): TurnResult['messages'] {
  return receipt.messages.flatMap((message) =>
    message.role === 'assistant' && typeof message.content === 'string'
      ? [{ id: message.id, role: 'assistant' as const, content: message.content }]
      : [],
  );
}

function isNativeFailure(error: unknown): boolean {
  if (!(error instanceof Error) || typeof error.cause !== 'object' || error.cause === null)
    return false;
  return (
    'role' in error.cause &&
    error.cause.role === 'assistant' &&
    'stopReason' in error.cause &&
    error.cause.stopReason === 'error'
  );
}
