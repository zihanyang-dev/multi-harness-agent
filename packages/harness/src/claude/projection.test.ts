import { EventType, type Message } from '@ag-ui/core';
import { expect, it } from 'vitest';

import type { HarnessTurnResult } from '../contract.js';
import { createRunEvents } from './projection.js';

it('projects only settled assistant text in message order', async () => {
  const result = Promise.resolve<HarnessTurnResult>({
    status: 'completed',
    messages: [
      { id: 'user', role: 'user', content: 'private input' },
      { id: 'empty', role: 'assistant', content: '' },
      { id: 'one', role: 'assistant', content: 'first' },
      { id: 'two', role: 'assistant', content: 'second' },
    ],
  });
  const events = [];
  for await (const event of createRunEvents({ threadId: 'thread', runId: 'run', result }))
    events.push(event);
  expect(events).toEqual([
    { type: EventType.RUN_STARTED, threadId: 'thread', runId: 'run' },
    { type: EventType.TEXT_MESSAGE_START, messageId: 'one', role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'one', delta: 'first' },
    { type: EventType.TEXT_MESSAGE_END, messageId: 'one' },
    { type: EventType.TEXT_MESSAGE_START, messageId: 'two', role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'two', delta: 'second' },
    { type: EventType.TEXT_MESSAGE_END, messageId: 'two' },
    {
      type: EventType.RUN_FINISHED,
      threadId: 'thread',
      runId: 'run',
      outcome: { type: 'success' },
    },
  ]);
});

it.each([
  { status: 'cancelled' as const, outcome: { type: 'cancelled' } },
  { status: 'paused' as const, outcome: { type: 'interrupt', interrupts: [] } },
])('preserves the settled $status outcome without inventing text', async ({ status, outcome }) => {
  const result = Promise.resolve<HarnessTurnResult>({ status, messages: [] });
  const events = [];
  for await (const event of createRunEvents({ threadId: 'thread', runId: 'run', result }))
    events.push(event);
  expect(events).toEqual([
    { type: EventType.RUN_STARTED, threadId: 'thread', runId: 'run' },
    { type: EventType.RUN_FINISHED, threadId: 'thread', runId: 'run', outcome },
  ]);
});

it('redacts execution failure without replacing the private rejection', async () => {
  const cause = new Error('Private execution payload');
  const result = Promise.reject<HarnessTurnResult>(cause);
  const events = [];
  for await (const event of createRunEvents({ threadId: 'thread', runId: 'run', result }))
    events.push(event);
  expect(events.at(-1)).toEqual({ type: EventType.RUN_ERROR, message: 'Claude run failed' });
  await expect(result).rejects.toBe(cause);
});

it('reports projection failure separately while retaining a fulfilled receipt', async () => {
  const message: Message = { id: 'answer', role: 'assistant' };
  Object.defineProperty(message, 'content', {
    get: () => {
      throw new Error('Private projection payload');
    },
  });
  const receipt: HarnessTurnResult = { status: 'completed', messages: [message] };
  const result = Promise.resolve(receipt);
  const events = [];
  for await (const event of createRunEvents({ threadId: 'thread', runId: 'run', result }))
    events.push(event);
  expect(events.at(-1)).toEqual({
    type: EventType.RUN_ERROR,
    message: 'Claude event observation failed',
  });
  expect(await result).toBe(receipt);
});
