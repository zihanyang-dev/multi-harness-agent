import { z } from 'zod';

export const TURN_QUEUE_NAME = 'turns';
export const EXECUTE_TURN_JOB_NAME = 'execute-turn';

/** Immutable execution identity, not a native SDK graph or a credential snapshot. */
export const PiBindingSchema = z.strictObject({
  harness: z.literal('pi'),
  sdkVersion: z.literal('1.1.0'),
  provider: z.string().min(1),
  model: z.string().min(1),
  policy: z.literal('text-v1'),
  storageId: z.string().min(1),
});
export type PiBinding = z.infer<typeof PiBindingSchema>;

export const ExecuteTurnJobSchema = z.strictObject({ turnId: z.string().min(1) });
export type ExecuteTurnJob = z.infer<typeof ExecuteTurnJobSchema>;
