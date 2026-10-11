import { type TurnInput, TurnInputSchema } from '@multi-harness/protocol/http';

export interface TurnSubmission {
  ownerId: string;
  threadId: string;
  requestId: string;
  input: TurnInput;
}

/** Captures caller input before IO; UUID spelling is canonical, owners and text remain exact. */
export function captureSubmission(submission: TurnSubmission): TurnSubmission {
  return {
    ownerId: submission.ownerId,
    threadId: submission.threadId.toLowerCase(),
    requestId: submission.requestId.toLowerCase(),
    input: TurnInputSchema.parse(submission.input),
  };
}

/** Authorization must precede replay. The owner's request key spans all their threads. */
export function decideTurnReplay(
  submission: TurnSubmission,
  existing: { threadId: string; input: unknown } | undefined,
): 'new' | 'replay' | 'conflict' {
  if (existing === undefined) return 'new';
  if (existing.threadId !== submission.threadId) return 'conflict';
  const retained = TurnInputSchema.safeParse(existing.input);
  if (!retained.success) return 'conflict';
  const parts = retained.data.content;
  if (parts.length !== submission.input.content.length) return 'conflict';
  return parts.every((part, index) => part.text === submission.input.content[index]?.text)
    ? 'replay'
    : 'conflict';
}
