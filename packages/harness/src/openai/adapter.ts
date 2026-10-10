import type {
  Agent,
  RunContext,
  Runner,
  RunResult,
  RunState,
  Session,
  StreamRunOptions,
} from '@openai/agents';

import type {
  HarnessProvider,
  HarnessRun,
  HarnessSession,
  HarnessTurnInput,
  HarnessTurnResult,
  OpenHarnessSessionOptions,
} from '../contract.js';
import { createOpenAISession } from './session.js';

// The SDK's broad output constraint preserves the concrete Agent's schema.
// biome-ignore lint/suspicious/noExplicitAny: Matches the SDK constraint without erasing the concrete Agent type.
export type OpenAIAgent<TContext> = Agent<TContext, any>;

/** Binds one trusted host factory without rebuilding its native Agent or Runner. */
export function createOpenAIHarness<C, A extends OpenAIAgent<C>>(
  options: CreateOpenAIHarnessOptions<C, A>,
): OpenAIHarness<C, A> {
  // Keep the factory binding stable; the host still owns scope and authorization per open.
  const source = { ...options };
  return {
    id: 'openai',
    resumable: source.resumable,
    openSession: (request) => openSession(source, request),
  };
}

export type OpenAIHarnessRunOptions<C, A extends OpenAIAgent<C>> = Omit<
  StreamRunOptions<C, A>,
  'stream' | 'session' | 'signal' | 'context' | 'conversationId' | 'previousResponseId'
>;

/** Native objects assembled by the host; only dispose transfers resource-release ownership. */
export interface OpenAISessionConfig<C, A extends OpenAIAgent<C>> {
  agent: A;
  runner: Runner;
  session: Session;
  context?: C | RunContext<C>;
  runOptions?: OpenAIHarnessRunOptions<C, A>;
  /** Trusted state restored against this root graph and history identity. */
  runState?: RunState<C, A>;
  /** Releases host-owned resources using their own lifecycle; never closes borrowed SDK resources. */
  dispose?: () => void | Promise<void>;
}

/** Native getters read live SDK state. Keep the native result on the trusted server. */
export interface OpenAITurnResult<C, A extends OpenAIAgent<C>> extends HarnessTurnResult {
  native: RunResult<C, A>;
}

export interface OpenAIRun<C, A extends OpenAIAgent<C>> extends HarnessRun {
  readonly result: Promise<OpenAITurnResult<C, A>>;
}

export interface OpenAIResumeOptions<C, A extends OpenAIAgent<C>> {
  result: RunResult<C, A>;
  input?: HarnessTurnInput;
  /** Synchronous native mutation; complete authorization and I/O before calling resume. */
  updateState?: (state: RunState<C, A>) => undefined;
}

export interface OpenAISession<C, A extends OpenAIAgent<C>> extends HarnessSession {
  readonly pendingRun: RunResult<C, A> | undefined;
  run: (input: HarnessTurnInput) => Promise<OpenAIRun<C, A>>;
  resume: (options: OpenAIResumeOptions<C, A>) => Promise<OpenAIRun<C, A>>;
}

export interface CreateOpenAIHarnessOptions<C, A extends OpenAIAgent<C>> {
  /** Host-verified history reopening, not a claim of crash recovery. */
  resumable: boolean;
  open: (options: OpenHarnessSessionOptions) => Promise<OpenAISessionConfig<C, A>>;
}

export interface OpenAIHarness<C, A extends OpenAIAgent<C>> extends HarnessProvider {
  readonly id: 'openai';
  openSession: (options: OpenHarnessSessionOptions) => Promise<OpenAISession<C, A>>;
}

async function openSession<C, A extends OpenAIAgent<C>>(
  source: CreateOpenAIHarnessOptions<C, A>,
  request: OpenHarnessSessionOptions,
): Promise<OpenAISession<C, A>> {
  // Reject unsupported requests before the host allocates execution resources.
  assertSessionRequest(request, source.resumable);

  // The host cleans partial setup if open throws; a returned config transfers cleanup to us.
  const config = await source.open(request);
  try {
    const nativeSessionId = await validateSessionConfig(config, request.nativeSessionId);
    return createOpenAISession(config, nativeSessionId);
  } catch (error) {
    return closeFailedOpening(config, error);
  }
}

function assertSessionRequest(request: OpenHarnessSessionOptions, resumable: boolean): void {
  if (request.nativeSessionId?.trim() === '')
    throw new Error('OpenAI native session ID must not be empty');
  if (request.nativeSessionId !== undefined && !resumable)
    throw new Error('OpenAI session source does not support resume');
}

async function validateSessionConfig<C, A extends OpenAIAgent<C>>(
  config: OpenAISessionConfig<C, A>,
  requestedSessionId: string | undefined,
): Promise<string> {
  // Stream, session and signal are supplied unconditionally. These remaining keys would change authority.
  for (const key of ['context', 'conversationId', 'previousResponseId']) {
    if (config.runOptions !== undefined && key in config.runOptions) {
      throw new Error(`OpenAI run option is wrapper-owned: ${key}`);
    }
  }

  // Some backends create history lazily here. The ID binds history, not authorization.
  const nativeSessionId = await config.session.getSessionId();
  if (nativeSessionId.trim() === '') throw new Error('OpenAI native session ID must not be empty');
  if (requestedSessionId !== undefined && requestedSessionId !== nativeSessionId) {
    throw new Error('OpenAI session source did not preserve the requested native session ID');
  }
  return nativeSessionId;
}

async function closeFailedOpening<C, A extends OpenAIAgent<C>>(
  config: OpenAISessionConfig<C, A>,
  error: unknown,
): Promise<never> {
  // Release only resources explicitly transferred by the host; retain both failures if release fails.
  try {
    await config.dispose?.();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], 'OpenAI session opening and cleanup failed');
  }
  throw error;
}
