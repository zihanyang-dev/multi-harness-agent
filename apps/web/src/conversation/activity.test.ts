import type { StrictActivityEvent } from '@multi-harness/protocol/http';
import { describe, expect, it } from 'vitest';
import { emptyActivity, reduceActivity } from './activity';

const turnId = '7cec584d-0881-4d20-b04d-78679659e633';
const text = (delta: string, messageId = 'answer') => ({
  type: 'TEXT_MESSAGE_CONTENT' as const,
  messageId,
  delta,
});
const start = {
  type: 'TEXT_MESSAGE_START' as const,
  messageId: 'answer',
  role: 'assistant' as const,
};
const apply = (state: ReturnType<typeof emptyActivity>, id: string, event: StrictActivityEvent) =>
  reduceActivity(state, { kind: 'activity', id, envelope: { turnId, event } });

describe('bounded turn activity projection', () => {
  it('rejects another turn and invalid Redis cursors', () => {
    const state = emptyActivity(turnId);
    expect(
      reduceActivity(state, {
        kind: 'activity',
        id: '1-0',
        envelope: { turnId: 'other', event: start },
      }),
    ).toBe(state);
    expect(apply(state, 'invalid', start)).toBe(state);
  });
  it('deduplicates replay and older IDs without concatenating text twice', () => {
    let state = apply(emptyActivity(turnId), '100-0', start);
    state = apply(state, '100-1', text('hello'));
    expect(apply(state, '100-1', text('hello'))).toBe(state);
    expect(apply(state, '99-9', text('old'))).toBe(state);
    expect(state.messages[0]?.text).toBe('hello');
  });
  it('clears partial text on gaps and refuses content without a new start', () => {
    let state = apply(apply(emptyActivity(turnId), '1-0', start), '2-0', text('fragment'));
    state = reduceActivity(state, { kind: 'gap' });
    expect(state.messages).toEqual([]);
    expect(state.missing).toBe(true);
    expect(apply(state, '3-0', text('tail')).messages).toEqual([]);
  });
  it('pairs parallel tool lifecycles by ID and retains bounded results', () => {
    let state = emptyActivity(turnId);
    for (const [id, toolCallId] of [
      ['1-0', 'a'],
      ['2-0', 'b'],
    ]) {
      state = reduceActivity(state, {
        kind: 'activity',
        id: id ?? '',
        envelope: {
          turnId,
          event: { type: 'TOOL_CALL_START', toolCallId: toolCallId ?? '', toolCallName: 'lookup' },
        },
      });
    }
    state = reduceActivity(state, {
      kind: 'activity',
      id: '3-0',
      envelope: { turnId, event: { type: 'TOOL_CALL_END', toolCallId: 'b' } },
    });
    state = reduceActivity(state, {
      kind: 'activity',
      id: '4-0',
      envelope: {
        turnId,
        event: {
          type: 'TOOL_CALL_RESULT',
          toolCallId: 'b',
          messageId: 'result',
          content: 'x'.repeat(20000),
          role: 'tool',
        },
      },
    });
    expect(state.tools.map((tool) => tool.status)).toEqual(['started', 'finished']);
    expect(state.tools[1]?.result?.length).toBeLessThanOrEqual(4000);
  });
  it('discards retry fragments and exposes process indicators only', () => {
    let state = apply(apply(emptyActivity(turnId), '1-0', start), '2-0', text('abandoned'));
    state = reduceActivity(state, {
      kind: 'activity',
      id: '3-0',
      envelope: { turnId, event: { type: 'CUSTOM', name: 'retry', value: { status: 'started' } } },
    });
    expect(state.messages).toEqual([]);
    expect(state.process).toEqual({ retry: 'started' });
  });
  it('settlement replaces ephemeral text and cannot be undone by late activity', () => {
    let state = apply(apply(emptyActivity(turnId), '1-0', start), '2-0', text('partial'));
    state = reduceActivity(state, { kind: 'snapshot', turnId, status: 'cancelled' });
    expect(state.messages).toEqual([]);
    expect(state.settled).toBe(true);
    expect(apply(state, '3-0', text('late'))).toBe(state);
  });
  it('ignores unrelated snapshots and clears unresolved execution activity', () => {
    const state = apply(emptyActivity(turnId), '1-0', start);
    expect(reduceActivity(state, { kind: 'snapshot', turnId: 'other', status: 'completed' })).toBe(
      state,
    );
    expect(
      reduceActivity(state, { kind: 'snapshot', turnId, status: 'needs_reconciliation' }).messages,
    ).toEqual([]);
  });
  it('caps retained text and entries rather than growing with the stream', () => {
    let state = emptyActivity(turnId);
    for (let index = 0; index < 100; index++) {
      const messageId = String(index);
      state = apply(state, `${index * 2 + 1}-0`, { ...start, messageId });
      state = apply(state, `${index * 2 + 2}-0`, text('x'.repeat(20000), messageId));
    }
    expect(state.messages.length).toBeLessThanOrEqual(32);
    expect(
      state.messages.reduce((size, message) => size + message.text.length, 0),
    ).toBeLessThanOrEqual(32000);
    expect(state.truncated).toBe(true);
  });
});

it('replaces only provisional messages with snapshots and retains tools, process, cursor fences', () => {
  let state = apply(apply(emptyActivity(turnId), '1-0', start), '2-0', text('stale'));
  state = apply(state, '3-0', {
    type: 'TOOL_CALL_START',
    toolCallId: 'tool',
    toolCallName: 'read',
  });
  state = apply(state, '4-0', { type: 'CUSTOM', name: 'reasoning', value: { status: 'finished' } });
  const event = {
    type: 'MESSAGES_SNAPSHOT' as const,
    messages: [{ id: 'replacement', role: 'assistant' as const, content: 'correct' }],
  };
  const replaced = apply(state, '5-0', event);
  expect(replaced.messages).toEqual([{ id: 'replacement', text: 'correct', ended: false }]);
  expect(replaced.tools).toEqual(state.tools);
  expect(replaced.process).toEqual(state.process);
  expect(replaced.settled).toBe(false);
  expect(apply(replaced, '5-0', event)).toBe(replaced);
  expect(apply(replaced, '4-9', event)).toBe(replaced);
  expect(apply(replaced, '6-0', text(' partial', 'replacement')).messages[0]?.text).toBe(
    'correct partial',
  );
  expect(apply(replaced, '7-0', { type: 'MESSAGES_SNAPSHOT', messages: [] }).messages).toEqual([]);
});

it('bounds replacement snapshots using the existing preview budget', () => {
  const state = apply(emptyActivity(turnId), '1-0', {
    type: 'MESSAGES_SNAPSHOT',
    messages: Array.from({ length: 128 }, (_, index) => ({
      id: String(index),
      role: 'assistant',
      content: 'x'.repeat(32000),
    })),
  });
  expect(state.messages.length).toBeLessThanOrEqual(32);
  expect(
    state.messages.reduce((size, message) => size + message.text.length, 0),
  ).toBeLessThanOrEqual(32000);
  expect(state.truncated).toBe(true);
});
