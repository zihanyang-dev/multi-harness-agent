import { z } from 'zod';

export const TURN_QUEUE_NAME = 'turns';
export const EXECUTE_TURN_JOB_NAME = 'execute-turn';

/** Immutable execution identity and reviewed tool policy, never an SDK graph or credentials. */
export const PiBindingSchema = z.strictObject({
  harness: z.literal('pi'),
  sdkVersion: z.literal('1.1.0'),
  provider: z.string().min(1),
  model: z.string().min(1),
  policy: z.enum(['text-v1', 'web-search-v1']),
  storageId: z.string().min(1),
});
export type PiBinding = z.infer<typeof PiBindingSchema>;

export const ExecuteTurnJobSchema = z.strictObject({ turnId: z.string().min(1) });
export type ExecuteTurnJob = z.infer<typeof ExecuteTurnJobSchema>;

/** Redis stream identity shared by producers and authorized observers; no transport dependency. */
export function turnActivityKey(prefix: string, turnId: string): string {
  return `${prefix}:turn-events:${turnId}`;
}
