import {
  Agent,
  RunItemStreamEvent,
  RunRawModelStreamEvent,
  type RunStreamEvent,
  RunToolCallItem,
  RunToolCallOutputItem,
} from '@openai/agents';
import { expect, it } from 'vitest';

import type { HarnessTurnResult } from '../contract.js';
import { createRunEvents } from './projection.js';

const identity = { threadId: 'thread', runId: 'run' };
async function* source(events: RunStreamEvent[] = []) {
  yield* events;
}

it('does not finish at source EOF while execution is still settling', async () => {
  const result = Promise.withResolvers<HarnessTurnResult>();
  const reachedEnd = Promise.withResolvers<void>();
  async function* nativeEvents() {
    yield new RunRawModelStreamEvent({
      type: 'output_text_delta',
      itemId: 'answer',
      delta: 'Partial',
    });
    reachedEnd.resolve();
  }
  const events = createRunEvents(nativeEvents(), { ...identity, result: result.promise });
  expect((await events.next()).value).toEqual({ type: 'RUN_STARTED', ...identity });
  await events.next();
  await events.next();
  let ended = false;
  const closing = events.next().then((event) => {
    ended = true;
    return event;
  });
  await reachedEnd.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(ended).toBe(false);
  result.resolve({ status: 'paused', messages: [] });
  expect((await closing).value).toEqual({ type: 'TEXT_MESSAGE_END', messageId: 'answer' });
  expect((await events.next()).value).toEqual({
    type: 'RUN_FINISHED',
    ...identity,
    outcome: { type: 'interrupt', interrupts: [] },
  });
});

it('fills an unobserved final message and excludes prior-attempt IDs', async () => {
  const result = Promise.resolve<HarnessTurnResult>({
    status: 'completed',
    messages: [
      { id: 'old', role: 'assistant', content: 'Old' },
      { id: 'answer', role: 'assistant', content: 'Done' },
    ],
  });
  const events = [];
  for await (const event of createRunEvents(source(), {
    ...identity,
    result,
    previousMessageIds: new Set(['old']),
  }))
    events.push(event);
  expect(events).toEqual([
    { type: 'RUN_STARTED', ...identity },
    { type: 'TEXT_MESSAGE_START', messageId: 'answer', role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'answer', delta: 'Done' },
    { type: 'TEXT_MESSAGE_END', messageId: 'answer' },
    { type: 'RUN_FINISHED', ...identity, outcome: { type: 'success' } },
  ]);
});

it('keeps settlement errors private and preserves the original failure', async () => {
  const result = Promise.withResolvers<HarnessTurnResult>();
  const failure = new Error('Private persistence failure');
  const events = createRunEvents(source(), { ...identity, result: result.promise });
  await events.next();
  result.reject(failure);
  // Delivery may remain suspended while the execution result rejects.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect((await events.next()).value).toEqual({ type: 'RUN_ERROR', message: 'OpenAI run failed' });
  expect(await events.next()).toEqual({ done: true, value: undefined });
  await expect(result.promise).rejects.toBe(failure);
});

it('keeps an observation failure separate from successful execution', async () => {
  const result = Promise.resolve<HarnessTurnResult>({ status: 'completed', messages: [] });
  async function* failedObservation(): AsyncGenerator<RunStreamEvent> {
    yield new RunRawModelStreamEvent({
      type: 'output_text_delta',
      itemId: 'answer',
      delta: 'Partial',
    });
    throw new Error('Private observation failure');
  }
  const events = [];
  for await (const event of createRunEvents(failedObservation(), { ...identity, result }))
    events.push(event);

  expect(events.at(-1)).toEqual({ type: 'RUN_ERROR', message: 'OpenAI event observation failed' });
  await expect(result).resolves.toEqual({ status: 'completed', messages: [] });
});

it('publishes reasoning PROCESS only, never raw reasoning or summary text', async () => {
  const events = [];
  for await (const event of createRunEvents(
    source([
      new RunRawModelStreamEvent({
        type: 'model',
        event: { type: 'response.reasoning_text.delta', delta: 'private' },
      }),
      new RunRawModelStreamEvent({
        type: 'model',
        event: { type: 'response.reasoning_summary_text.delta', delta: 'also private' },
      }),
      new RunRawModelStreamEvent({
        type: 'model',
        event: { type: 'response.reasoning_summary_text.done', text: 'private summary' },
      }),
    ]),
    { ...identity, result: Promise.resolve({ status: 'completed', messages: [] }) },
  ))
    events.push(event);
  expect(events.slice(1, -1)).toEqual([
    { type: 'CUSTOM', name: 'reasoning', value: { status: 'started' } },
    { type: 'CUSTOM', name: 'reasoning', value: { status: 'finished' } },
  ]);
  expect(JSON.stringify(events)).not.toContain('private');
});

it('projects completed function-call generation and native execution results without arguments or output', async () => {
  const agent = new Agent({ name: 'fixture' });
  const call = new RunToolCallItem(
    { type: 'function_call', callId: 'tool', name: 'search', arguments: 'private args' },
    agent,
  );
  const output = new RunToolCallOutputItem(
    {
      type: 'function_call_result',
      callId: 'tool',
      name: 'search',
      status: 'completed',
      output: { type: 'text', text: 'private output' },
    },
    agent,
    'private output',
    undefined,
    'executed',
  );
  const events = [];
  for await (const event of createRunEvents(
    source([
      new RunItemStreamEvent('tool_called', call),
      new RunItemStreamEvent('tool_output', output),
    ]),
    { ...identity, result: Promise.resolve({ status: 'completed', messages: [] }) },
  ))
    events.push(event);
  expect(events.slice(1, -1)).toEqual([
    { type: 'TOOL_CALL_START', toolCallId: 'tool', toolCallName: 'search' },
    { type: 'TOOL_CALL_END', toolCallId: 'tool' },
    {
      type: 'TOOL_CALL_RESULT',
      messageId: expect.any(String),
      toolCallId: 'tool',
      content: 'Tool finished.',
      role: 'tool',
    },
  ]);
  expect(JSON.stringify(events)).not.toContain('private');
});
