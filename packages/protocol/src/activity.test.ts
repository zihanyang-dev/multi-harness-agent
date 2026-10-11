import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { turnActivityKey } from './execution.js';
import { ActivityEnvelopeSchema } from './http.js';

it('accepts only bounded public activity envelopes', () => {
  const turnId = randomUUID();
  const event = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'hello' };
  expect(ActivityEnvelopeSchema.parse({ turnId, event })).toEqual({ turnId, event });
  for (const invalid of [
    { turnId, event, rawEvent: {} },
    { turnId, event: { ...event, rawEvent: {} } },
    { turnId, event: { ...event, delta: '' } },
    { turnId, event: { ...event, delta: 'x'.repeat(32001) } },
    { turnId, event: { type: 'RUN_FINISHED' } },
    {
      turnId,
      event: {
        type: 'CUSTOM',
        name: 'reasoning',
        value: { status: 'started', thoughts: 'secret' },
      },
    },
    { turnId: 'bad', event },
  ])
    expect(ActivityEnvelopeSchema.safeParse(invalid).success).toBe(false);
  expect(turnActivityKey('test', turnId)).toBe(`test:turn-events:${turnId}`);
});

it('accepts each strict whitelisted AGUI shape', () => {
  for (const event of [
    { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' },
    { type: 'TEXT_MESSAGE_END', messageId: 'm' },
    { type: 'TOOL_CALL_START', toolCallId: 't', toolCallName: 'read', parentMessageId: 'm' },
    { type: 'TOOL_CALL_END', toolCallId: 't' },
    { type: 'TOOL_CALL_RESULT', messageId: 'm', toolCallId: 't', content: '', role: 'tool' },
    ...['reasoning', 'compaction', 'retry'].map((name) => ({
      type: 'CUSTOM',
      name,
      value: { status: 'finished' },
    })),
  ])
    expect(ActivityEnvelopeSchema.safeParse({ turnId: randomUUID(), event }).success).toBe(true);
});

it('accepts only bounded plain assistant message snapshots', () => {
  const turnId = randomUUID();
  const message = { id: 'm', role: 'assistant', content: 'replacement' };
  const snapshot = { type: 'MESSAGES_SNAPSHOT', messages: [message] };
  expect(ActivityEnvelopeSchema.safeParse({ turnId, event: snapshot }).success).toBe(true);
  for (const event of [
    { ...snapshot, rawEvent: {} },
    { type: 'RAW', event: snapshot },
    ...[
      { ...message, native: {} },
      { ...message, role: 'user' },
      { ...message, toolCalls: [] },
      { ...message, content: 'x'.repeat(32001) },
      { ...message, id: 'x'.repeat(32001) },
    ].map((invalid) => ({ ...snapshot, messages: [invalid] })),
    { ...snapshot, messages: Array.from({ length: 129 }, () => message) },
  ])
    expect(ActivityEnvelopeSchema.safeParse({ turnId, event }).success).toBe(false);
});
