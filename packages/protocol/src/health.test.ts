import { expect, it } from 'vitest';
import { HealthResponseSchema } from './health.js';

it('rejects responses that do not claim the defined liveness state', () => {
  expect(HealthResponseSchema.safeParse({ status: 'ready-for-production' }).success).toBe(false);
});
