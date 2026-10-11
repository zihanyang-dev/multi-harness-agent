import { describe, expect, it } from 'vitest';
import {
  canSubmitDraft,
  createSubmission,
  isBlockingStatus,
  isUncertainFailure,
  preferTurnSnapshot,
} from './conversation';

describe('conversation request safety', () => {
  it('preserves leading spaces, newlines and trailing spaces in immutable input', () => {
    const request = createSubmission('  hello\nworld  ', '7cec584d-0881-4d20-b04d-78679659e633');
    expect(request).toEqual({
      requestId: '7cec584d-0881-4d20-b04d-78679659e633',
      input: { content: [{ type: 'text', text: '  hello\nworld  ' }] },
    });
  });
  it('rejects whitespace-only drafts and counts UTF-16 rather than code points', () => {
    expect(canSubmitDraft(' \n ')).toBe(false);
    expect(canSubmitDraft('😀'.repeat(16000))).toBe(true);
    expect(canSubmitDraft('😀'.repeat(16001))).toBe(false);
  });
  it('blocks unresolved execution but allows only settled statuses', () => {
    for (const status of ['accepted', 'running', 'needs_reconciliation'] as const)
      expect(isBlockingStatus(status)).toBe(true);
    for (const status of ['completed', 'failed', 'cancelled'] as const)
      expect(isBlockingStatus(status)).toBe(false);
  });
  it('treats network and server errors as uncertain, not validation rejections', () => {
    expect(isUncertainFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(isUncertainFailure({ status: 503 })).toBe(true);
    expect(isUncertainFailure({ status: 400 })).toBe(false);
    expect(isUncertainFailure({ status: 409 })).toBe(false);
  });
});

// A slow HTTP read must not undo a newer SSE terminal snapshot.
describe('authoritative snapshot ordering', () => {
  const running = {
    id: '7cec584d-0881-4d20-b04d-78679659e633',
    threadId: '1fafb871-8644-444f-aec4-9b68c1826d8e',
    input: { content: [{ type: 'text' as const, text: 'hello' }] },
    acceptedAt: '2026-10-11T00:00:00.000Z',
    status: 'running' as const,
    result: null,
    failureCode: null,
    finishedAt: null,
  };
  it('retains settled authority over a late active response', () => {
    const completed = {
      ...running,
      status: 'completed' as const,
      result: { messages: [] },
      finishedAt: '2026-10-11T00:01:00.000Z',
    };
    expect(preferTurnSnapshot(completed, running)).toBe(completed);
  });
  it('does not rewind running or reconciliation to acceptance', () => {
    expect(preferTurnSnapshot(running, { ...running, status: 'accepted' })).toBe(running);
    const unresolved = {
      ...running,
      status: 'needs_reconciliation' as const,
      failureCode: 'execution_unknown' as const,
    };
    expect(preferTurnSnapshot(unresolved, running)).toBe(unresolved);
  });
  it('allows reconciliation to settle and never substitutes another turn', () => {
    const unresolved = {
      ...running,
      status: 'needs_reconciliation' as const,
      failureCode: 'execution_unknown' as const,
    };
    const cancelled = {
      ...running,
      status: 'cancelled' as const,
      result: { messages: [] },
      finishedAt: '2026-10-11T00:01:00.000Z',
    };
    expect(preferTurnSnapshot(unresolved, cancelled)).toBe(cancelled);
    const other = { ...running, id: 'another' };
    expect(preferTurnSnapshot(cancelled, other)).toBe(other);
  });
});
