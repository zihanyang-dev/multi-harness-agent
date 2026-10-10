import type { AgentSession, PromptOptions } from '@earendil-works/pi-coding-agent';

import type { HarnessProvider, HarnessSession, OpenHarnessSessionOptions } from '../contract.js';
import { createPiSession } from './session.js';

/** Binds a trusted host factory without rebuilding its native session or capabilities. */
export function createPiHarness(options: CreatePiHarnessOptions): PiHarness {
  const source = { ...options };
  return {
    id: 'pi',
    resumable: source.resumable,
    openSession: (request) => openSession(source, request),
  };
}

export type PiHarnessPromptOptions = Omit<PromptOptions, 'images'>;

/** The host prepares native bindings and coordinates every writer, including extensions. */
export interface PiSessionConfig {
  session: AgentSession;
  promptOptions?: PiHarnessPromptOptions;
  /** Releases explicitly transferred resources through their native lifecycle. */
  dispose?: () => void | Promise<void>;
}

export interface CreatePiHarnessOptions {
  /** Host-verified history reopening, not crash recovery. */
  resumable: boolean;
  open: (options: OpenHarnessSessionOptions) => Promise<PiSessionConfig>;
}

export interface PiHarness extends HarnessProvider {
  readonly id: 'pi';
}

async function openSession(
  source: CreatePiHarnessOptions,
  options: OpenHarnessSessionOptions,
): Promise<HarnessSession> {
  const request = { ...options };
  assertSessionRequest(request, source.resumable);

  // Partial setup remains the host's responsibility until a config is returned.
  const config = await source.open({ ...request });
  try {
    const nativeSessionId = validateSessionConfig(config, request.nativeSessionId);
    return createPiSession(config, nativeSessionId);
  } catch (error) {
    return closeFailedOpening(config, error);
  }
}

function assertSessionRequest(request: OpenHarnessSessionOptions, resumable: boolean): void {
  if (request.nativeSessionId?.trim() === '')
    throw new Error('Pi native session ID must not be empty');
  if (request.nativeSessionId !== undefined && !resumable)
    throw new Error('Pi session source does not support resume');
}

function validateSessionConfig(
  config: PiSessionConfig,
  requestedSessionId: string | undefined,
): string {
  const nativeSessionId = config.session.sessionId;
  if (nativeSessionId.trim() === '') throw new Error('Pi native session ID must not be empty');
  if (requestedSessionId !== undefined && requestedSessionId !== nativeSessionId)
    throw new Error('Pi session source did not preserve the requested native session ID');
  return nativeSessionId;
}

async function closeFailedOpening(config: PiSessionConfig, error: unknown): Promise<never> {
  try {
    await config.dispose?.();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], 'Pi session opening and cleanup failed');
  }
  throw error;
}
