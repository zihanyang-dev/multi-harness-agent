import { randomUUID } from 'node:crypto';

import {
  type AgentInputItem,
  RunResult,
  type RunState,
  type StreamedRunResult,
} from '@openai/agents';

import type { HarnessTurnInput, HarnessTurnResult } from '../contract.js';
import type {
  OpenAIAgent,
  OpenAIResumeOptions,
  OpenAIRun,
  OpenAISession,
  OpenAISessionConfig,
  OpenAITurnResult,
} from './adapter.js';
import { createRunEvents, toMessages } from './projection.js';
import { toNativeInput } from './request.js';

interface Execution {
  abort: AbortController;
  done: PromiseWithResolvers<void>;
}

interface SessionState<C, A extends OpenAIAgent<C>> {
  config: OpenAISessionConfig<C, A>;
  nativeSessionId: string;
  status: 'open' | 'failed' | 'disposed';
  active: Execution | undefined;
  pending: { kind: 'paused' | 'cancelled' | 'restored'; native: RunResult<C, A> } | undefined;
  closing: Promise<void> | undefined;
}

/** Creates one local execution owner; the host retains cross-session coordination. */
export function createOpenAISession<C, A extends OpenAIAgent<C>>(
  config: OpenAISessionConfig<C, A>,
  nativeSessionId: string,
): OpenAISession<C, A> {
  // Snapshot the binding and run options, not the host's native graph or mutable context.
  const { runState, ...binding } = config;
  const state: SessionState<C, A> = {
    config: { ...binding, runOptions: { ...binding.runOptions } },
    nativeSessionId,
    status: 'open',
    active: undefined,
    pending:
      runState === undefined ? undefined : { kind: 'restored', native: new RunResult(runState) },
    closing: undefined,
  };
  return {
    nativeSessionId,
    get pendingRun() {
      return state.pending?.native;
    },
    run: (input) => runSession(state, input),
    resume: (options) => resumeSession(state, options),
    dispose: () => disposeSession(state),
  };
}

async function runSession<C, A extends OpenAIAgent<C>>(
  state: SessionState<C, A>,
  input: HarnessTurnInput,
): Promise<OpenAIRun<C, A>> {
  assertAvailable(state);
  // A fresh turn may abandon a cancelled attempt, but must not bypass pending approvals.
  if (state.pending !== undefined && state.pending.kind !== 'cancelled') {
    throw new Error('OpenAI session has a pending interrupted run');
  }
  const nativeInput = toNativeInput(input);
  const execution = reserveExecution(state);
  state.pending = undefined;
  return startExecution(state, execution, nativeInput);
}

async function resumeSession<C, A extends OpenAIAgent<C>>(
  state: SessionState<C, A>,
  options: OpenAIResumeOptions<C, A>,
): Promise<OpenAIRun<C, A>> {
  assertAvailable(state);
  if (state.pending?.native !== options.result) {
    throw new Error('OpenAI continuation is stale or belongs to another session');
  }
  const input = options.input === undefined ? undefined : toNativeInput(options.input);
  // Native results are live views. Capture observations before the host mutates their shared state.
  const previousMessageIds = new Set(
    toMessages(options.result.newItems).map((message) => message.id),
  );
  // Reserve before native mutation or a host callback that could reenter this session.
  const execution = reserveExecution(state);

  try {
    if (input !== undefined) options.result.state.addInput(input);
    const returned: unknown = options.updateState?.(options.result.state);
    if (returned !== undefined) {
      void Promise.resolve(returned).catch(() => undefined);
      throw new Error('OpenAI state updater must be synchronous and return undefined');
    }
  } catch (error) {
    // Input or approvals may already have changed. There is no safe rollback or direct retry.
    state.status = 'failed';
    state.active = undefined;
    execution.done.resolve();
    throw error;
  }

  // Resume the exact SDK state under the same root, Runner and history, never a rebuilt transcript.
  return startExecution(state, execution, options.result.state, previousMessageIds);
}

function disposeSession<C, A extends OpenAIAgent<C>>(state: SessionState<C, A>): Promise<void> {
  if (state.closing !== undefined) return state.closing;
  // Publish closing before abort: signal listeners may synchronously reenter dispose.
  state.status = 'disposed';
  state.closing = releaseSession(state);
  state.active?.abort.abort();
  return state.closing;
}

function reserveExecution<C, A extends OpenAIAgent<C>>(state: SessionState<C, A>): Execution {
  // Writer release has its own latch; it must remain joinable when run.result rejects.
  const execution = { abort: new AbortController(), done: Promise.withResolvers<void>() };
  state.active = execution;
  return execution;
}

async function startExecution<C, A extends OpenAIAgent<C>>(
  state: SessionState<C, A>,
  execution: Execution,
  input: AgentInputItem[] | RunState<C, A>,
  previousMessageIds: ReadonlySet<string> = new Set(),
): Promise<OpenAIRun<C, A>> {
  const { config } = state;
  let native: StreamedRunResult<C, A>;
  try {
    // The official loop runs independently of readers. Do not add another event pump or queue.
    native = await config.runner.run<A, C>(config.agent, input, {
      ...config.runOptions,
      stream: true,
      session: config.session,
      ...(config.context === undefined ? {} : { context: config.context }),
      signal: execution.abort.signal,
    });
  } catch (error) {
    // SDK initialization can fail before a streamed result exists.
    if (state.status === 'open') state.status = 'failed';
    state.active = undefined;
    execution.done.resolve();
    throw error;
  }

  const result = settleRun(state, execution, native, previousMessageIds);
  // Observe rejection even if the host never consumes either output; keep the original promise.
  void result.catch(() => undefined);
  return {
    events: createRunEvents(readNativeEvents(native), {
      threadId: state.nativeSessionId,
      runId: randomUUID(),
      result,
      previousMessageIds,
    }),
    result,
    interrupt: async () => {
      execution.abort.abort();
      await execution.done.promise;
    },
  };
}

async function* readNativeEvents<C, A extends OpenAIAgent<C>>(run: StreamedRunResult<C, A>) {
  // Acquire the sole native reader only when observed; return releases it without SDK cancellation.
  yield* run.toStream().values({ preventCancel: true });
}

async function settleRun<C, A extends OpenAIAgent<C>>(
  state: SessionState<C, A>,
  execution: Execution,
  run: StreamedRunResult<C, A>,
  previousMessageIds: ReadonlySet<string>,
): Promise<OpenAITurnResult<C, A>> {
  try {
    // Join the SDK's public outcome, not an observer or an invented resource-finalization signal.
    await run.completed;
    const status = runStatus(run);
    const native = new RunResult(run.state);
    const result = { status, messages: toMessages(native.newItems, previousMessageIds), native };
    state.pending = status === 'completed' ? undefined : { kind: status, native };
    return result;
  } catch (error) {
    if (state.status === 'open') state.status = 'failed';
    throw error;
  } finally {
    // Observation may still be pending; it neither holds the writer nor changes execution outcome.
    state.active = undefined;
    execution.done.resolve();
  }
}

function runStatus<C, A extends OpenAIAgent<C>>(
  run: StreamedRunResult<C, A>,
): HarnessTurnResult['status'] {
  // Classify only fulfilled completion; abort flags or pending approvals must not mask SDK failure.
  if (run.cancelled) return 'cancelled';
  if (run.interruptions.length > 0) return 'paused';
  return 'completed';
}

async function releaseSession<C, A extends OpenAIAgent<C>>(
  state: SessionState<C, A>,
): Promise<void> {
  // Join this wrapper's outcome, then await host-owned cleanup. SDK-owned resources stay with the SDK.
  await state.active?.done.promise;
  await state.config.dispose?.();
}

function assertAvailable<C, A extends OpenAIAgent<C>>(state: SessionState<C, A>): void {
  // A failed attempt may have committed effects; only host reconciliation can establish a new owner.
  if (state.status === 'disposed') throw new Error('OpenAI session is disposed');
  if (state.status === 'failed')
    throw new Error('OpenAI session execution failed; reconcile before restoring');
  if (state.active !== undefined) throw new Error('OpenAI session already has an active run');
}
