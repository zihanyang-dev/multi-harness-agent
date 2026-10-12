import type {
  Harness,
  HarnessUpdate,
  PermissionPolicy,
  PermissionRequest,
  PromptInput,
  PromptOptions,
  PromptResult,
  QuestionRequest,
  QuestionResponse,
  SessionOptions,
  ToolResult,
} from '@multi-harness/harness';

// Type-only consumers: no factory, SDK, model calls or simulated execution.
export async function interactivePrompt(
  harness: Harness,
  environment: SessionOptions,
  input: PromptInput,
  callbacks: Required<Pick<PromptOptions, 'onUpdate' | 'onQuestion'>>,
): Promise<PromptResult> {
  const session = await harness.newSession(environment);
  try {
    return await session.prompt(input, callbacks);
  } finally {
    await session.close();
  }
}

export const chooseStyle: QuestionRequest = {
  id: 'request-1',
  questions: [
    {
      id: 'style',
      question: 'Which visual style should I use?',
      options: [
        { id: 'minimal', label: 'Minimal' },
        { id: 'cinematic', label: 'Cinematic', description: 'Dramatic camera movement.' },
      ],
      multiple: false,
      allowCustom: true,
    },
    {
      id: 'formats',
      question: 'Which output formats do you need?',
      options: [
        { id: 'mp4', label: 'MP4' },
        { id: 'webm', label: 'WebM' },
      ],
      multiple: true,
      allowCustom: false,
    },
  ],
};

export const accepted: QuestionResponse = {
  action: 'accept',
  answers: [
    { questionId: 'style', optionIds: ['minimal'], text: 'Use warm colors.' },
    { questionId: 'formats', optionIds: ['mp4', 'webm'] },
  ],
};
export const customAnswer: QuestionResponse = {
  action: 'accept',
  answers: [{ questionId: 'style', optionIds: [], text: 'Documentary' }],
};
export const declined: QuestionResponse = { action: 'decline' };
export const dismissed: QuestionResponse = { action: 'cancel' };

export const sandboxPermissions: PermissionPolicy = { mode: 'allow_all' };
export const reviewedPermissions: PermissionPolicy = {
  mode: 'ask',
  onRequest: async (request: PermissionRequest, { signal }) => {
    if (signal.aborted) return { action: 'deny', reason: 'Invocation cancelled.' };
    return { action: request.toolName === 'read_file' ? 'allow' : 'deny' };
  },
};

export const plan: HarnessUpdate = {
  type: 'plan',
  entries: [{ content: 'Render the selected concept.', status: 'in_progress' }],
};

// Returning output does not prove success: a native error classification can be absent.
export const toolResult: ToolResult = {
  content: [
    { type: 'text', text: 'Rendering finished.' },
    { type: 'file', source: new Uint8Array([1, 2, 3]), mimeType: 'video/mp4' },
  ],
  structuredContent: { durationSeconds: 30, formats: ['mp4'] },
};
export const finishedTool: HarnessUpdate = {
  type: 'tool',
  toolCallId: 'render-1',
  name: 'render',
  phase: 'finished',
  result: toolResult,
};
export const requestedTool: HarnessUpdate = {
  type: 'tool',
  toolCallId: 'render-1',
  phase: 'requested',
};
export const partialTool: HarnessUpdate = {
  type: 'tool',
  toolCallId: 'render-1',
  phase: 'running',
  result: { content: [{ type: 'text', text: 'Rendering frame 10.' }] },
};
export const activityNotice: HarnessUpdate = {
  type: 'activity',
  activityId: 'compaction-1',
  name: 'compaction',
  phase: 'observed',
};

export const completedTools: PromptResult = {
  stopReason: 'end_turn',
  messages: [],
  toolResults: [
    { toolCallId: 'render-1', name: 'render', result: toolResult },
    { toolCallId: 'unreported-name-1', result: toolResult },
  ],
};

export function completedToolName(result: PromptResult): string | undefined {
  return result.toolResults[0]?.name;
}

export function completedToolOutput(result: PromptResult): ToolResult | undefined {
  return result.toolResults[0]?.result;
}

export function rejectImplicitPermissions(): void {
  // @ts-expect-error Omitting a callback is not an explicit permission policy.
  const environment: SessionOptions = { cwd: '/workspace', stateDirectory: '/state' };
  void environment;
}

export function rejectUnansweredPermissionPolicy(): void {
  // @ts-expect-error Interactive permission policy requires a decision callback.
  const policy: PermissionPolicy = { mode: 'ask' };
  void policy;
}

export function rejectAnswersOnDismissal(): void {
  // @ts-expect-error Dismissing a question does not submit answers.
  const response: QuestionResponse = { action: 'cancel', answers: [] };
  void response;
}

export function rejectAcceptanceWithoutAnswers(): void {
  // @ts-expect-error Acceptance includes answers for validation against the original questions.
  const response: QuestionResponse = { action: 'accept' };
  void response;
}

export function rejectNativeToolGraph(result: ToolResult): void {
  // @ts-expect-error Structured public content is JSON, not native SDK objects or functions.
  const invalid: ToolResult = { ...result, structuredContent: { execute: () => undefined } };
  void invalid;
}
