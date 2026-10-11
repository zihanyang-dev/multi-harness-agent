import { MessageSchema } from '@ag-ui/core/schemas';
import { z } from 'zod';

/** Ordered text input, validated without normalizing the accepted request. */
export const TurnInputSchema = z
  .strictObject({
    content: z
      .array(z.strictObject({ type: z.literal('text'), text: z.string() }))
      .min(1)
      .max(32),
  })
  .refine((input) => input.content.some((part) => part.text.trim().length > 0), {
    message: 'Turn input must contain non-whitespace text',
  })
  .refine(
    (input) => input.content.reduce((length, part) => length + part.text.length, 0) <= 32000,
    {
      message: 'Turn input must not exceed 32000 UTF-16 characters',
    },
  );

export const SubmitTurnSchema = z.strictObject({
  requestId: z.uuid(),
  input: TurnInputSchema,
});

/** Authorized identity and stored tool policy; absent legacy capabilities are not inferred. */
export const ThreadSchema = z.strictObject({
  id: z.uuid(),
  harness: z.literal('pi'),
  tools: z.array(z.literal('web_search')).max(1).optional(),
  createdAt: z.iso.datetime(),
});

/** Plain display preview; not a mutable conversation name. */
export const ThreadSummarySchema = ThreadSchema.extend({ title: z.string().min(1).max(120) });
export const ThreadListSchema = z.strictObject({
  threads: z.array(ThreadSummarySchema),
  nextCursor: z.uuid().nullable(),
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;
export type ThreadList = z.infer<typeof ThreadListSchema>;

export const TurnResultSchema = z.strictObject({ messages: z.array(MessageSchema) });
export type TurnResult = z.infer<typeof TurnResultSchema>;

const turnFields = {
  id: z.uuid(),
  threadId: z.uuid(),
  input: TurnInputSchema,
  acceptedAt: z.iso.datetime(),
};

/** Public lifecycle facts; unresolved execution does not imply a settled outcome. */
export const TurnSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...turnFields,
    status: z.enum(['accepted', 'running']),
    result: z.null(),
    failureCode: z.null(),
    finishedAt: z.null(),
  }),
  z.strictObject({
    ...turnFields,
    status: z.literal('needs_reconciliation'),
    result: z.null(),
    failureCode: z.enum([
      'binding_mismatch',
      'invalid_input',
      'execution_unknown',
      'cleanup_failed',
      'result_commit_unknown',
      'unsupported_pause',
    ]),
    finishedAt: z.null(),
  }),
  z.strictObject({
    ...turnFields,
    status: z.enum(['completed', 'cancelled']),
    result: TurnResultSchema,
    failureCode: z.null(),
    finishedAt: z.iso.datetime(),
  }),
  z.strictObject({
    ...turnFields,
    status: z.literal('failed'),
    result: z.null(),
    failureCode: z.literal('execution_failed'),
    finishedAt: z.iso.datetime(),
  }),
]);

export type TurnInput = z.infer<typeof TurnInputSchema>;
export type SubmitTurn = z.infer<typeof SubmitTurnSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type Turn = z.infer<typeof TurnSchema>;

export {
  type ActivityEnvelope,
  ActivityEnvelopeSchema,
  type StrictActivityEvent,
  StrictActivityEventSchema,
} from './activity.js';
export { type HealthResponse, HealthResponseSchema } from './health.js';
