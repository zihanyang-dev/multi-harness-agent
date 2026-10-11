import type { Query, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  HarnessProvider,
  HarnessRun,
  HarnessSession,
  HarnessTurnInput,
  HarnessTurnResult,
  OpenHarnessSessionOptions,
} from '../contract.js';
import { createInputStream, type InputStream } from './request.js';
import { createClaudeSession } from './session.js';

/** Binds a trusted host factory; Claude retains its process, loop, tools and transcript semantics. */
export function createClaudeHarness(options: CreateClaudeHarnessOptions): ClaudeHarness {
  const source = { ...options };
  return {
    id: 'claude',
    resumable: source.resumable,
    openSession: (request) => openSession(source, request),
  };
}

/** Transfers the Query's sole reader and close ownership, not its native configuration graph. */
export interface ClaudeSessionConfig {
  query: Query;
  /** Selected new UUID or host-authorized resume ID; verified against subsequent native frames. */
  nativeSessionId: string;
  /** Releases additional resources explicitly transferred by the host. */
  dispose?: () => void | Promise<void>;
}

/** The full native receipt stays on the trusted server; public events expose no private payload. */
export interface ClaudeTurnResult extends HarnessTurnResult {
  native: SDKResultMessage;
}

export interface ClaudeRun extends HarnessRun {
  readonly result: Promise<ClaudeTurnResult>;
}

export interface ClaudeSession extends HarnessSession {
  run: (input: HarnessTurnInput) => Promise<ClaudeRun>;
}

export interface CreateClaudeHarnessOptions {
  /** Host-verified persisted history reopening, not crash recovery. */
  resumable: boolean;
  /** Creates query({ prompt, options }) with authorized native scope and no competing reader/writer. */
  open: (
    options: OpenHarnessSessionOptions,
    prompt: AsyncIterable<SDKUserMessage>,
  ) => Promise<ClaudeSessionConfig>;
}

export interface ClaudeHarness extends HarnessProvider {
  readonly id: 'claude';
  openSession: (options: OpenHarnessSessionOptions) => Promise<ClaudeSession>;
}

async function openSession(
  source: CreateClaudeHarnessOptions,
  options: OpenHarnessSessionOptions,
): Promise<ClaudeSession> {
  // Keep the admitted scope authoritative while the host receives its own mutable request copy.
  const request = { ...options };
  if (request.nativeSessionId?.trim() === '')
    throw new Error('Claude native session ID must not be empty');
  if (request.nativeSessionId !== undefined && !source.resumable)
    throw new Error('Claude session source does not support resume');
  const input = createInputStream();
  let config: ClaudeSessionConfig;
  try {
    // Partial native allocation remains host-owned if the factory rejects.
    config = await source.open({ ...request }, input.prompt);
  } catch (error) {
    input.close();
    throw error;
  }
  try {
    // Snapshot the binding bag, not Query, MCP servers, permission callbacks or native options.
    config = { ...config };
    if (config.nativeSessionId.trim() === '')
      throw new Error('Claude native session ID must not be empty');
    if (request.nativeSessionId !== undefined && request.nativeSessionId !== config.nativeSessionId)
      throw new Error('Claude session source did not preserve the requested native session ID');
    // Initialization metadata has no session ID. Opening does not prove transcript materialization.
    return createClaudeSession(config, input);
  } catch (error) {
    return closeFailedOpening(config, input, error);
  }
}

async function closeFailedOpening(
  config: ClaudeSessionConfig,
  input: InputStream,
  error: unknown,
): Promise<never> {
  // A returned Query has transferred ownership even when identity validation rejects the opening.
  const errors: unknown[] = [error];
  input.close();
  try {
    config.query.close();
  } catch (cleanupError) {
    errors.push(cleanupError);
  }
  try {
    await config.query.return();
  } catch (cleanupError) {
    errors.push(cleanupError);
  }
  try {
    await config.dispose?.();
  } catch (cleanupError) {
    errors.push(cleanupError);
  }
  if (errors.length > 1)
    throw new AggregateError(errors, 'Claude session opening and cleanup failed');
  throw error;
}
