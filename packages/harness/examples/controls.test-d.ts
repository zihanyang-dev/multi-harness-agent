import type {
  Harness,
  HarnessError,
  HarnessSession,
  PromptInput,
  PromptOptions,
  PromptResult,
} from '@multi-harness/harness';

// Type-only consumers: no SDK, model calls, simulated execution or control-outcome claims.
// The host supplies a fresh invocation ID for each prompt on this handle.
export function promptWithIdentity(
  session: HarnessSession,
  input: PromptInput,
  invocationId: string,
): Promise<PromptResult> {
  const options: PromptOptions = { invocationId };
  return session.prompt(input, options);
}

export function interruptInvocation(session: HarnessSession, invocationId: string): Promise<void> {
  return session.interrupt(invocationId);
}

export function steerInvocation(
  session: HarnessSession,
  input: PromptInput,
  invocationId: string,
): Promise<void> {
  return session.steer(input, { invocationId });
}

export function canSteer(harness: Harness): boolean {
  return harness.capabilities.steer;
}

export const incompatibleSessionCode: HarnessError['code'] = 'session_incompatible';

export async function rejectUnscopedInterrupt(session: HarnessSession): Promise<void> {
  // @ts-expect-error Interrupt must target one exact invocation, not whichever prompt is active.
  await session.interrupt();
}

export async function rejectUnscopedSteer(
  session: HarnessSession,
  input: PromptInput,
): Promise<void> {
  // @ts-expect-error Steering must carry the target invocation ID.
  await session.steer(input);
}

export async function rejectSteerWithoutIdentity(
  session: HarnessSession,
  input: PromptInput,
): Promise<void> {
  // @ts-expect-error An empty options object does not scope steering to an invocation.
  await session.steer(input, {});
}
