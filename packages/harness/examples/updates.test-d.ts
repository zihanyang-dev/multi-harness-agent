import type {
  AssistantContent,
  AssistantMessage,
  Harness,
  HarnessCapabilities,
  HarnessSession,
  HarnessUpdate,
  PromptInput,
  PromptOptions,
  PromptResult,
} from '@multi-harness/harness';

// Type-only consumers, not a simulated stream or evidence of native SDK execution.
export const featureCapabilities: HarnessCapabilities = {
  resumeSession: true,
  steer: true,
  input: ['text', 'file'],
  reasoning: true,
  questions: true,
  permissionRequests: true,
};
export const reasoningOptions: PromptOptions = { includeReasoning: true };
export const output: readonly AssistantMessage[] = [
  {
    id: 'response-1',
    content: [
      { id: 'reasoning-1', type: 'reasoning', text: 'Comparing the available formats.' },
      { id: 'answer-1', type: 'text', text: 'Use MP4.' },
      { id: 'reasoning-2', type: 'reasoning', text: 'Checking browser support.' },
      { id: 'answer-2', type: 'text', text: 'WebM is also supported.' },
    ],
  },
];
export const snapshot: HarnessUpdate = { type: 'messages', messages: output };
export const reasoningDelta: HarnessUpdate = {
  type: 'reasoning_delta',
  messageId: 'response-1',
  contentId: 'reasoning-1',
  delta: ' MP4 has broad support.',
};
export const textDelta: HarnessUpdate = {
  type: 'text_delta',
  messageId: 'response-1',
  contentId: 'answer-1',
  delta: ' It is widely supported.',
};
export const confirmed: PromptResult = {
  stopReason: 'end_turn',
  messages: output,
  toolResults: [],
};

export function canExposeReasoning(harness: Harness): boolean {
  return harness.capabilities.reasoning;
}

export function contentForDisplay(result: PromptResult): readonly AssistantMessage[] {
  return result.messages;
}

// Borrows a caller-owned session; reasoning does not require an observation callback.
export async function outputWithoutObservation(
  session: HarnessSession,
  input: PromptInput,
): Promise<readonly AssistantMessage[]> {
  const result = await session.prompt(input, { includeReasoning: true });
  return result.messages;
}

export function activityLabel(update: HarnessUpdate): string | undefined {
  if (update.type !== 'activity') return undefined;
  return `${update.activityId}: ${update.name} (${update.phase})`;
}

export function rejectRestoreCapability(capabilities: HarnessCapabilities): void {
  // @ts-expect-error Resume replaces the old restore capability.
  const invalid: HarnessCapabilities = { ...capabilities, restoreSession: true };
  void invalid;
}

export function rejectUpdatesInventory(capabilities: HarnessCapabilities): void {
  // @ts-expect-error Capabilities describe features, not an inventory of observable events.
  const invalid: HarnessCapabilities = { ...capabilities, updates: ['text_delta'] };
  void invalid;
}

export function rejectMissingSteer(capabilities: Omit<HarnessCapabilities, 'steer'>): void {
  // @ts-expect-error Steer availability must be explicitly declared even when false.
  const invalid: HarnessCapabilities = capabilities;
  void invalid;
}

export function rejectUnaddressedDelta(): void {
  // @ts-expect-error A delta needs a content ID; one response can contain multiple same-kind blocks.
  const update: HarnessUpdate = { type: 'text_delta', messageId: 'response-1', delta: 'MP4' };
  void update;
}

export function rejectUnscopedReasoningDelta(): void {
  // @ts-expect-error Content IDs are scoped to a message, not global native block indices.
  const update: HarnessUpdate = { type: 'reasoning_delta', contentId: 'reasoning-1', delta: 'MP4' };
  void update;
}

export function rejectPrivateReplaySignature(part: AssistantContent): void {
  // @ts-expect-error Opaque replay state does not belong in public display content.
  const invalid: AssistantContent = { ...part, signature: 'opaque-replay-state' };
  void invalid;
}

export function rejectUnidentifiedActivity(): void {
  // @ts-expect-error Repeated or overlapping activities cannot be correlated only by name.
  const update: HarnessUpdate = { type: 'activity', name: 'retry', phase: 'observed' };
  void update;
}

export function rejectAmbiguousActivity(): void {
  // @ts-expect-error A notice explicitly says observed; missing phase is not an implicit interval.
  const update: HarnessUpdate = { type: 'activity', activityId: 'retry-1', name: 'retry' };
  void update;
}
