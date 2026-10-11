import { randomUUID, type UUID } from 'node:crypto';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { type ActivityChannel, createActivityChannel } from '../activity-channel.js';
import type { HarnessTurnInput } from '../contract.js';
import type { ClaudeRun, ClaudeSession, ClaudeSessionConfig, ClaudeTurnResult } from './adapter.js';
import {
  createActivityProjector,
  createRunEvents,
  observeMessage,
  type RunObservation,
  toRunStatus,
} from './projection.js';
import { type InputStream, toNativeInput } from './request.js';

interface Execution {
  promptId: UUID;
  result: PromiseWithResolvers<ClaudeTurnResult>;
  observation: RunObservation;
  activity: ActivityChannel;
  project: (message: SDKMessage) => void;
  stopping: Promise<void> | undefined;
}

interface SessionState {
  config: ClaudeSessionConfig;
  input: InputStream;
  active: Execution | undefined;
  failed: boolean;
  disposed: boolean;
  closing: Promise<void> | undefined;
}

/** Owns the transferred Query's input and sole native reader; the SDK owns its agent loop. */
export function createClaudeSession(
  config: ClaudeSessionConfig,
  input: InputStream,
): ClaudeSession {
  const state: SessionState = {
    config: { ...config },
    input,
    active: undefined,
    failed: false,
    disposed: false,
    closing: undefined,
  };
  const reader = readSession(state);
  return {
    nativeSessionId: state.config.nativeSessionId,
    run: (request) => runSession(state, request),
    dispose: () => disposeSession(state, reader),
  };
}

async function runSession(state: SessionState, input: HarnessTurnInput): Promise<ClaudeRun> {
  if (state.disposed) throw new Error('Claude session is disposed');
  if (state.failed)
    throw new Error('Claude session is closed or failed; reconcile before reopening');
  if (state.active !== undefined) throw new Error('Claude session already has an active run');

  const text = toNativeInput(input);
  const promptId = randomUUID();
  const activity = createActivityChannel();
  const observation: RunObservation = { messages: new Map(), aborted: false };
  const execution: Execution = {
    promptId,
    activity,
    project: createActivityProjector(activity, promptId, observation),
    result: Promise.withResolvers<ClaudeTurnResult>(),
    observation,
    stopping: undefined,
  };
  // Reserve before handing input to the native producer; consumers never drive execution.
  state.active = execution;
  void execution.result.promise.catch(() => undefined);
  try {
    state.input.submit({
      type: 'user',
      uuid: execution.promptId,
      session_id: state.config.nativeSessionId,
      parent_tool_use_id: null,
      message: { role: 'user', content: text },
    });
  } catch (error) {
    state.active = undefined;
    execution.result.reject(error);
    throw error;
  }
  return {
    events: createRunEvents({
      threadId: state.config.nativeSessionId,
      runId: execution.promptId,
      result: execution.result.promise,
      activity,
    }),
    result: execution.result.promise,
    interrupt: () => interruptExecution(state, execution),
  };
}

async function readSession(state: SessionState): Promise<void> {
  try {
    // Query.return() closes native execution; public observation must never borrow this iterator.
    for await (const message of state.config.query) {
      if ('session_id' in message && message.session_id !== state.config.nativeSessionId)
        throw new Error('Claude native session identity changed');

      const execution = state.active;
      if (execution === undefined) continue;
      const native = observeMessage(message, execution.observation, execution.promptId);
      execution.project(message);
      if (native === undefined) continue;

      // Fence an already-issued session-scoped interrupt, even if its ACK follows the result.
      // With no fence, settle without yielding so a late interrupt cannot enter this writer.
      if (execution.stopping !== undefined) await execution.stopping;

      try {
        const status = toRunStatus(native, execution.observation);
        execution.result.resolve({
          status,
          messages: [...execution.observation.messages.values()],
          native,
        });
      } catch (error) {
        // An attributable turn error is recoverable on the same live Query, unlike reader failure.
        execution.result.reject(error);
      }
      execution.activity.close();
      state.active = undefined;
    }
    throw new Error('Claude native query closed without an active turn result');
  } catch (error) {
    state.failed = true;
    state.active?.result.reject(error);
    state.active?.activity.close();
    state.active = undefined;
    state.input.close();
    // Native iterator cleanup has already joined its bounded SDK teardown here.
  }
}

async function interruptExecution(state: SessionState, execution: Execution): Promise<void> {
  if (state.active !== execution || state.disposed) return;
  if (execution.stopping === undefined) {
    // Query.interrupt() awaits the native ACK only. Keep the writer until an attributable result.
    execution.stopping = state.config.query.interrupt().then(() => undefined);
    void execution.stopping.catch((error: unknown) => {
      if (state.active !== execution) return;
      // Failed delivery leaves execution unknown. Reject locally, but retain its owner until teardown.
      state.failed = true;
      execution.result.reject(error);
    });
  }
  await execution.stopping;
}

function disposeSession(state: SessionState, reader: Promise<void>): Promise<void> {
  if (state.closing !== undefined) return state.closing;
  state.disposed = true;
  const closing = Promise.withResolvers<void>();
  // Publish before close or host cleanup can synchronously reenter disposal.
  state.closing = closing.promise;
  void releaseSession(state, reader).then(closing.resolve, closing.reject);
  return state.closing;
}

async function releaseSession(state: SessionState, reader: Promise<void>): Promise<void> {
  const errors: unknown[] = [];
  const stopping = state.active?.stopping;
  state.input.close();
  try {
    // close wakes pending native reads; return is a bounded SDK cleanup receipt, not OS exit proof.
    state.config.query.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    // Still join native return if close threw; one failed cleanup stage cannot skip another owner.
    await state.config.query.return();
  } catch (error) {
    errors.push(error);
  }
  try {
    // A rejected native return cannot release host resources ahead of the owned reader.
    await reader;
  } catch (error) {
    errors.push(error);
  }

  // Interrupt delivery and transferred host cleanup have independent failures.
  try {
    await stopping;
  } catch (error) {
    errors.push(error);
  }
  try {
    await state.config.dispose?.();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, 'Claude query shutdown and cleanup failed');
}
