import { randomUUID } from 'node:crypto';

import type {
  HarnessRun,
  HarnessSession,
  HarnessTurnInput,
  HarnessTurnResult,
} from '../contract.js';
import type { PiSessionConfig } from './adapter.js';
import { createRunEvents, subscribeRun, toMessages, toRunStatus } from './projection.js';
import { toNativeInput } from './request.js';

interface Execution {
  done: PromiseWithResolvers<void>;
  interruptRequested: boolean;
  stopping: Promise<void> | undefined;
}

interface SessionState {
  config: PiSessionConfig;
  nativeSessionId: string;
  disposed: boolean;
  active: Execution | undefined;
  closing: Promise<void> | undefined;
}

/** Owns local submissions; native capabilities and external writers remain host-coordinated. */
export function createPiSession(config: PiSessionConfig, nativeSessionId: string): HarnessSession {
  // Snapshot host bindings and options, not the borrowed native session graph.
  const state: SessionState = {
    config: { ...config, promptOptions: { ...config.promptOptions } },
    nativeSessionId,
    disposed: false,
    active: undefined,
    closing: undefined,
  };
  return {
    nativeSessionId,
    run: (input) => runSession(state, input),
    dispose: () => disposeSession(state),
  };
}

async function runSession(state: SessionState, input: HarnessTurnInput): Promise<HarnessRun> {
  assertAvailable(state);
  const text = toNativeInput(input);
  // Include every existing branch so an extension's branch switch cannot replay old display text.
  const previousEntryIds = new Set(
    state.config.session.sessionManager.getEntries().map((entry) => entry.id),
  );
  const execution: Execution = {
    done: Promise.withResolvers<void>(),
    interruptRequested: false,
    stopping: undefined,
  };
  state.active = execution;

  const result = settleRun(state, execution, text, previousEntryIds);
  // Keep the original result observable even when neither output is consumed.
  void result.catch(() => undefined);
  return {
    events: createRunEvents({ threadId: state.nativeSessionId, runId: randomUUID(), result }),
    result,
    interrupt: () => interruptExecution(state, execution),
  };
}

async function settleRun(
  state: SessionState,
  execution: Execution,
  text: string,
  previousEntryIds: ReadonlySet<string>,
): Promise<HarnessTurnResult> {
  const { session, promptOptions } = state.config;
  let unsubscribe: (() => void) | undefined;
  try {
    const subscription = subscribeRun(session, () => {
      // Pi has no preflight AbortSignal. Reissue an early request when native execution starts.
      if (execution.interruptRequested) requestInterruption(state, execution);
    });
    unsubscribe = subscription.unsubscribe;
    // Preserve host prompt options; this text-only slice supplies no images.
    await session.prompt(text, { ...promptOptions, images: [] });
    if (session.sessionId !== state.nativeSessionId)
      throw new Error('Pi native session changed during execution');
    const status = toRunStatus(subscription.observation);
    // message_end precedes native append; read history after the owned prompt has joined.
    return { status, messages: toMessages(session.sessionManager.getBranch(), previousEntryIds) };
  } finally {
    unsubscribe?.();
    state.active = undefined;
    execution.done.resolve();
  }
}

function requestInterruption(state: SessionState, execution: Execution): void {
  // An old run handle must never abort a newer native invocation.
  if (state.active !== execution) return;
  execution.interruptRequested = true;
  const stopping = state.config.session.abort();
  const previous = execution.stopping;
  // Join every abort request, including one reissued after preflight.
  execution.stopping =
    previous === undefined ? stopping : Promise.all([previous, stopping]).then(() => undefined);
  void execution.stopping.catch(() => undefined);
}

async function interruptExecution(state: SessionState, execution: Execution): Promise<void> {
  requestInterruption(state, execution);
  // Native idle alone is not the owned prompt's completion boundary.
  await execution.done.promise;
  await execution.stopping;
}

function disposeSession(state: SessionState): Promise<void> {
  if (state.closing !== undefined) return state.closing;
  state.disposed = true;
  // Publish closing before SDK abort handlers can synchronously reenter this method.
  state.closing = releaseSession(state);
  if (state.active !== undefined) requestInterruption(state, state.active);
  return state.closing;
}

async function releaseSession(state: SessionState): Promise<void> {
  const execution = state.active;
  await execution?.done.promise;
  // A failed abort must not skip transferred cleanup or erase its independent failure.
  const errors: unknown[] = [];
  try {
    await execution?.stopping;
  } catch (error) {
    errors.push(error);
  }
  // The host owns native shutdown hooks and any work outside this wrapper's invocation.
  try {
    await state.config.dispose?.();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, 'Pi session interruption and cleanup failed');
}

function assertAvailable(state: SessionState): void {
  if (state.disposed) throw new Error('Pi session is disposed');
  if (state.active !== undefined || !state.config.session.isIdle)
    throw new Error('Pi session already has an active run');
  if (state.config.session.sessionId !== state.nativeSessionId)
    throw new Error('Pi native session binding changed');
}
