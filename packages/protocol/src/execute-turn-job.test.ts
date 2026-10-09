import { describe, expect, it } from 'vitest';
import { ExecuteTurnJobSchema } from './execute-turn-job.js';

describe('ExecuteTurnJobSchema', () => {
  it('accepts a stable turn reference without copying user content', () => {
    expect(ExecuteTurnJobSchema.parse({ turnId: 'turn_123' })).toEqual({ turnId: 'turn_123' });
  });

  it('rejects an empty turn reference', () => {
    expect(ExecuteTurnJobSchema.safeParse({ turnId: '' }).success).toBe(false);
  });

  it('rejects undeclared job fields', () => {
    expect(ExecuteTurnJobSchema.safeParse({ turnId: 'turn_123', prompt: 'secret' }).success).toBe(
      false,
    );
  });
});
