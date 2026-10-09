import { z } from 'zod';

export const ExecuteTurnJobSchema = z.strictObject({ turnId: z.string().min(1) });
export type ExecuteTurnJob = z.infer<typeof ExecuteTurnJobSchema>;
