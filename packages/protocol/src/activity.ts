import { z } from 'zod';

/** Disposable display facts and replacement snapshots, never native payloads or hidden reasoning. */
export const StrictActivityEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('MESSAGES_SNAPSHOT'),
    messages: z
      .array(
        z.strictObject({
          id: z.string().max(32000),
          role: z.literal('assistant'),
          content: z.string().max(32000),
        }),
      )
      .max(128),
  }),
  z.strictObject({
    type: z.literal('TEXT_MESSAGE_START'),
    messageId: z.string(),
    role: z.literal('assistant'),
  }),
  z.strictObject({
    type: z.literal('TEXT_MESSAGE_CONTENT'),
    messageId: z.string(),
    delta: z.string().min(1).max(32000),
  }),
  z.strictObject({ type: z.literal('TEXT_MESSAGE_END'), messageId: z.string() }),
  z.strictObject({
    type: z.literal('TOOL_CALL_START'),
    toolCallId: z.string(),
    toolCallName: z.string(),
    parentMessageId: z.string().optional(),
  }),
  z.strictObject({ type: z.literal('TOOL_CALL_END'), toolCallId: z.string() }),
  z.strictObject({
    type: z.literal('TOOL_CALL_RESULT'),
    messageId: z.string(),
    toolCallId: z.string(),
    content: z.string().max(32000),
    role: z.literal('tool'),
  }),
  z.strictObject({
    type: z.literal('CUSTOM'),
    name: z.enum(['reasoning', 'compaction', 'retry']),
    value: z.strictObject({ status: z.enum(['started', 'finished']) }),
  }),
]);
export const ActivityEnvelopeSchema = z.strictObject({
  turnId: z.uuid(),
  event: StrictActivityEventSchema,
});
export type StrictActivityEvent = z.infer<typeof StrictActivityEventSchema>;
export type ActivityEnvelope = z.infer<typeof ActivityEnvelopeSchema>;
