import type {
  CreateHarness,
  Harness,
  HarnessConfig,
  HarnessSession,
  HarnessUpdate,
  PromptInput,
  PromptOptions,
  PromptResult,
  ResumeSessionOptions,
  SessionOptions,
} from '@multi-harness/harness';

// The factory has no implementation yet. These examples check its proposed public type only.
declare const createHarness: CreateHarness;

export async function evaluate(
  config: HarnessConfig,
  environment: SessionOptions,
  input: PromptInput,
): Promise<PromptResult> {
  const harness = await createHarness(config);
  const session = await harness.newSession(environment);
  try {
    return await session.prompt(input);
  } finally {
    await session.close();
  }
}

export async function interact(
  config: HarnessConfig,
  environment: SessionOptions,
  input: PromptInput,
  interaction: { signal: AbortSignal; display: (update: HarnessUpdate) => void },
): Promise<PromptResult> {
  const harness = await createHarness(config);
  const session = await harness.newSession(environment);
  const options: PromptOptions = {
    signal: interaction.signal,
    onUpdate: interaction.display,
  };
  try {
    return await session.prompt(input, options);
  } finally {
    await session.close();
  }
}

export async function continueConversation(
  config: HarnessConfig,
  environment: SessionOptions,
  sessionId: string,
  input: PromptInput,
): Promise<PromptResult> {
  const harness = await createHarness(config);
  const options: ResumeSessionOptions = { ...environment, sessionId };
  const session = await harness.resumeSession(options);
  try {
    return await session.prompt(input);
  } finally {
    await session.close();
  }
}

export async function rejectNativeConstruction(config: HarnessConfig): Promise<void> {
  // @ts-expect-error External callers must not supply a native SDK constructor.
  await createHarness({ ...config, openNative: () => ({}) });
}

export function rejectAmbiguousInput(input: PromptInput): void {
  // @ts-expect-error Input is ordered content, not a replacement native conversation.
  const withHistory: PromptInput = { ...input, nativeHistory: [] };
  void withHistory;
}

export async function rejectProviderlessPi(): Promise<void> {
  // @ts-expect-error Pi model resolution requires an explicit provider.
  await createHarness({ kind: 'pi', model: 'gpt-5.5', apiKey: 'test-only' });
}

export async function rejectRestoreSession(
  harness: Harness,
  options: ResumeSessionOptions,
): Promise<HarnessSession> {
  // @ts-expect-error Resume replaces the old restore method.
  return harness.restoreSession(options);
}

export function rejectNativeResumeState(options: ResumeSessionOptions): void {
  // @ts-expect-error Resume takes a session identity and host policy, not a native SDK graph.
  const invalid: ResumeSessionOptions = { ...options, nativeState: { messages: [] } };
  void invalid;
}

export function rejectSyntheticCancellation(result: PromptResult): void {
  // @ts-expect-error A cancellation request is not an execution stop reason.
  const acknowledged: PromptResult = { ...result, stopReason: 'cancel_requested' };
  void acknowledged;
}
