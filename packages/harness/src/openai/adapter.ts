import { randomUUID } from 'node:crypto';
import {
  Agent,
  type AgentInputItem,
  OpenAIConversationsSession,
  OpenAIResponsesModel,
  type RunItem,
  Runner,
} from '@openai/agents';
import { APIUserAbortError, type default as OpenAI } from 'openai';

import type {
  HarnessProvider,
  HarnessRun,
  HarnessSession,
  HarnessTurnInput,
  HarnessTurnResult,
  OpenHarnessSessionOptions,
} from '../contract.js';
import { createRunEvents, toMessages } from './output.js';

/** Fixed provider configuration; session identity and turn input belong to the public contract. */
export interface CreateOpenAIHarnessOptions {
  client: OpenAI;
  model: string;
  instructions?: string;
}

interface ActiveTurn {
  readonly controller: AbortController;
  readonly settlement: PromiseWithResolvers<void>;
}

/** Only the native facts needed to settle and project this turn. */
interface NativeTurnOutput {
  readonly completed: Promise<void>;
  readonly cancelled: boolean;
  readonly newItems: readonly RunItem[];
}

/** Native dependencies and lifecycle belong to this wrapper, not to event readers. */
interface SessionState {
  readonly nativeSessionId: string;
  readonly nativeSession: OpenAIConversationsSession;
  readonly agent: Agent;
  readonly runner: Runner;
  active: ActiveTurn | undefined;
  disposal: Promise<void> | undefined;
}

/**
 * Creates the text-only adapter around the official Runner and Conversations store.
 *
 * The host owns the client and cross-wrapper write serialization. Opening a new session
 * creates remote history; disposing a wrapper does not delete it. SDK tracing is disabled.
 */
export function createOpenAIHarness(options: CreateOpenAIHarnessOptions): HarnessProvider {
  return {
    id: 'openai',
    // These describe this adapter's current boundary, not everything the SDK can support.
    capabilities: {
      resume: true,
      steer: false,
      visibleReasoning: false,
      customTools: false,
      mcp: false,
      skills: false,
    },
    openSession: (sessionOptions) => openSession(options, sessionOptions),
  };
}

async function openSession(
  configuration: CreateOpenAIHarnessOptions,
  options: OpenHarnessSessionOptions,
): Promise<HarnessSession> {
  assertSessionOptions(options);
  const nativeSession = new OpenAIConversationsSession({
    client: configuration.client,
    ...(options.nativeSessionId !== undefined ? { conversationId: options.nativeSessionId } : {}),
  });
  const nativeSessionId = await nativeSession.getSessionId();
  const agent = new Agent({
    name: 'Assistant',
    instructions: configuration.instructions ?? '',
    model: new OpenAIResponsesModel(configuration.client, configuration.model),
  });

  // One wrapper owns this lifecycle. Other writers of the same native ID require host serialization.
  const state: SessionState = {
    nativeSessionId,
    nativeSession,
    agent,
    runner: new Runner({ tracingDisabled: true }),
    active: undefined,
    disposal: undefined,
  };

  return {
    nativeSessionId,
    run: (input) => runTurn(input, state),
    dispose: () => disposeSession(state),
  };
}

/** Holds the writer through SDK setup, execution and history persistence. */
async function runTurn(input: HarnessTurnInput, state: SessionState): Promise<HarnessRun> {
  if (state.disposal) throw new Error('OpenAI session is disposed');
  if (state.active) throw new Error('OpenAI session already has an active run');
  const nativeInput = toNativeInput(input);

  // Reserve before awaiting Runner setup; cancellation and disposal must see the pending turn.
  const turn: ActiveTurn = {
    controller: new AbortController(),
    settlement: Promise.withResolvers<void>(),
  };
  state.active = turn;

  try {
    const nativeRun = await state.runner.run(state.agent, nativeInput, {
      stream: true,
      session: state.nativeSession,
      signal: turn.controller.signal,
    });
    const result = finishTurn(nativeRun, turn, state);

    // Execution is independent of readers; observe failures even if neither output is consumed.
    void result.catch(() => {});
    return {
      result,
      events: createRunEvents(nativeRun.toStream().values({ preventCancel: true }), {
        threadId: state.nativeSessionId,
        runId: randomUUID(),
        result,
      }),
      async interrupt() {
        // A retained handle from an older turn must not interrupt a newer one.
        if (state.active === turn) turn.controller.abort();
      },
    };
  } catch (error) {
    // Runner setup can fail before it returns a streamed result.
    releaseTurn(turn, state);
    throw error;
  }
}

/** Projects the settled outcome, preserving failures the SDK delivers outside our abort wrapper. */
async function finishTurn(
  nativeRun: NativeTurnOutput,
  turn: ActiveTurn,
  state: SessionState,
): Promise<HarnessTurnResult> {
  try {
    await nativeRun.completed;
    return {
      status: nativeRun.cancelled ? 'cancelled' : 'completed',
      messages: toMessages(nativeRun.newItems),
    };
  } catch (error) {
    // SDK 0.20.0 misses the client's abort wrapper. Match our reason, preserving other errors.
    // The client can already fold a concurrent fetch failure into this wrapper after abort.
    const signal = turn.controller.signal;
    if (!signal.aborted || !(error instanceof APIUserAbortError) || error.cause !== signal.reason)
      throw error;
    return { status: 'cancelled', messages: toMessages(nativeRun.newItems) };
  } finally {
    // Native completion includes history persistence for this configured text-only Runner.
    releaseTurn(turn, state);
  }
}

/** Releases local write ownership and lets disposal finish joining this turn. */
function releaseTurn(turn: ActiveTurn, state: SessionState): void {
  state.active = undefined;
  turn.settlement.resolve();
}

/** Stops admitting turns, requests interruption and joins the current native settlement. */
function disposeSession(state: SessionState): Promise<void> {
  if (state.disposal) return state.disposal;
  state.active?.controller.abort();
  state.disposal = state.active?.settlement.promise ?? Promise.resolve();
  // Releasing this wrapper must not delete the remote conversation or close the borrowed client.
  return state.disposal;
}

function assertSessionOptions(options: OpenHarnessSessionOptions): void {
  if (options.nativeSessionId !== undefined && options.nativeSessionId.trim() === '')
    throw new Error('OpenAI native session ID must not be empty');
  if (options.tools?.length)
    throw new Error('Custom tools are not connected to the OpenAI adapter yet');
  if (options.mcpServers?.length) throw new Error('MCP is not connected to the OpenAI adapter yet');
  if (options.skills) throw new Error('Skills are not connected to the OpenAI adapter yet');
}

function toNativeInput(input: HarnessTurnInput): AgentInputItem[] {
  const content = input.content.map((part) => {
    // File mapping is a separate integration step; never silently remove a requested attachment.
    if (part.type === 'file')
      throw new Error('File input is not connected to the OpenAI adapter yet');
    return { type: 'input_text' as const, text: part.text };
  });
  return [{ role: 'user', content }];
}
