import { EventType, type Message } from '@ag-ui/core';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { expect, it } from 'vitest';
import { createActivityChannel } from '../activity-channel.js';
import type { HarnessTurnResult } from '../contract.js';
import { createActivityProjector, createRunEvents, observeMessage } from './projection.js';

import { createInputStream } from './request.js';
import { createClaudeSession } from './session.js';

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

it('projects attributed partial text before receipt and drops foreign stream fragments', async () => {
  const channel = createActivityChannel();
  const project = createActivityProjector(channel, 'prompt');
  const frame = (event: unknown, user_message_uuid?: string) =>
    ({
      type: 'stream_event',
      session_id: 'session',
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-000000000001',
      event,
      user_message_uuid,
    }) as unknown as SDKMessage;
  project(frame({ type: 'message_start', message: { id: 'native' } }, 'other'));
  project(
    frame({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'private' },
    }),
  );
  project(frame({ type: 'message_start', message: { id: 'native' } }, 'prompt'));
  project(
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'public' } }),
  );
  expect((await channel.events.next()).value).toMatchObject({ type: 'TEXT_MESSAGE_START' });
  expect((await channel.events.next()).value).toMatchObject({
    type: 'TEXT_MESSAGE_CONTENT',
    delta: 'public',
  });
  project(frame({ type: 'message_stop' }));
  expect((await channel.events.next()).value).toMatchObject({ type: 'TEXT_MESSAGE_END' });
});

it('keeps foreign and aborted assistant fragments out of the authoritative receipt', () => {
  const observation = { messages: new Map(), aborted: false };
  const assistant = (extra: object) =>
    ({
      type: 'assistant',
      parent_tool_use_id: null,
      uuid: 'reply',
      session_id: 'session',
      message: { content: [{ type: 'text', text: 'fragment' }] },
      ...extra,
    }) as unknown as SDKMessage;
  observeMessage(assistant({ user_message_uuid: 'foreign' }), observation, 'prompt');
  expect(observation.messages.size).toBe(0);
  observeMessage(assistant({ aborted: true }), observation, 'prompt');
  expect(observation.messages.size).toBe(0);
  expect(observation.aborted).toBe(true);
});

it('return wakes an outstanding observation read without waiting for native settlement', async () => {
  const result = Promise.withResolvers<HarnessTurnResult>();
  const activity = createActivityChannel();
  const events = createRunEvents({
    threadId: 'thread',
    runId: 'run',
    result: result.promise,
    activity,
  });
  await events.next();
  const read = events.next();
  const closing = events.return(undefined);
  // No timer: the observation return itself must wake the pending read.
  await closing;
  expect(await read).toMatchObject({ done: true });
  result.resolve({ status: 'completed', messages: [] });
});

it('projects tool-call generation, native results and thinking lifecycle without private payloads', async () => {
  const activity = createActivityChannel();
  const project = createActivityProjector(activity, 'prompt');
  const frame = (event: unknown) =>
    ({
      type: 'stream_event',
      parent_tool_use_id: null,
      session_id: 'session',
      uuid: '00000000-0000-4000-8000-000000000001',
      user_message_uuid: 'prompt',
      event,
    }) as SDKMessage;
  project(
    frame({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: 'private' },
    }),
  );
  project(frame({ type: 'content_block_stop', index: 0 }));
  project(
    frame({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'call', name: 'search', input: { private: true } },
    }),
  );
  project(
    frame({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: 'private args' },
    }),
  );
  project(frame({ type: 'content_block_stop', index: 1 }));
  project({
    type: 'user',
    parent_tool_use_id: null,
    session_id: 'session',
    uuid: '00000000-0000-4000-8000-000000000002',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call', content: 'private output' }],
    },
  } as SDKMessage);
  activity.close();
  const events = [];
  for await (const event of activity.events) events.push(event);
  expect(events).toEqual([
    { type: 'CUSTOM', name: 'reasoning', value: { status: 'started' } },
    { type: 'CUSTOM', name: 'reasoning', value: { status: 'finished' } },
    { type: 'TOOL_CALL_START', toolCallId: 'call', toolCallName: 'search' },
    { type: 'TOOL_CALL_END', toolCallId: 'call' },
    {
      type: 'TOOL_CALL_RESULT',
      messageId: expect.any(String),
      toolCallId: 'call',
      content: 'Tool finished.',
      role: 'tool',
    },
  ]);
  expect(JSON.stringify(events)).not.toContain('private');
});

it('abandons an overflow catch without joining or settling the native receipt', async () => {
  const receipt = Promise.withResolvers<import('../contract.js').HarnessTurnResult>();
  const activity = createActivityChannel();
  const events = createRunEvents({
    threadId: 'thread',
    runId: 'run',
    result: receipt.promise,
    activity,
  });
  await events.next();
  const read = events.next();
  for (let index = 0; index < 257; index++)
    activity.push({ type: EventType.CUSTOM, name: 'retry', value: { status: 'started' } });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const closing = events.return(undefined);
  const closed = await Promise.race([
    closing.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
  ]);
  // Always release the test's native producer, including in RED.
  let settled = false;
  void receipt.promise.then(() => {
    settled = true;
  });
  expect(settled).toBe(false);
  receipt.resolve({ status: 'completed', messages: [] });
  await closing;
  expect(await read).toMatchObject({ done: true });
  expect(await receipt.promise).toEqual({ status: 'completed', messages: [] });
  expect(closed).toBe(true);
});

it.each(['supersedes', 'refusal'] as const)(
  'withdraws streamed refusal on %s before the formal receipt',
  async (kind) => {
    const activity = createActivityChannel();
    const project = createActivityProjector(activity, 'prompt');
    const stream = (event: unknown) =>
      ({
        type: 'stream_event',
        parent_tool_use_id: null,
        user_message_uuid: 'prompt',
        event,
      }) as SDKMessage;
    const assistant = (uuid: string, content: string, extra = {}) =>
      ({
        type: 'assistant',
        uuid,
        parent_tool_use_id: null,
        user_message_uuid: 'prompt',
        message: {
          content: [
            { type: 'text', text: content },
            { type: 'thinking', thinking: 'private thought' },
          ],
        },
        ...extra,
      }) as unknown as SDKMessage;
    project(stream({ type: 'message_start' }));
    project(
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'stale refusal' },
      }),
    );
    project(assistant('stale', 'stale refusal'));
    if (kind === 'refusal') {
      project({
        type: 'system',
        subtype: 'model_refusal_fallback',
        retracted_message_uuids: ['stale'],
      } as SDKMessage);
    }
    project(
      assistant('answer', 'correct answer', kind === 'supersedes' ? { supersedes: ['stale'] } : {}),
    );
    activity.close();
    const events = [];
    for await (const event of activity.events) events.push(event);
    expect(events.filter((event) => event.type === EventType.MESSAGES_SNAPSHOT).at(-1)).toEqual({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [{ id: 'answer', role: 'assistant', content: 'correct answer' }],
    });
    if (kind === 'refusal')
      expect(events).toContainEqual({ type: EventType.MESSAGES_SNAPSHOT, messages: [] });
    expect(JSON.stringify(events)).not.toContain('private thought');
  },
);

it('keeps an uncancelled replacement partial in a withdrawal snapshot', async () => {
  const activity = createActivityChannel();
  const project = createActivityProjector(activity, 'prompt');
  project({
    type: 'assistant',
    uuid: 'stale',
    parent_tool_use_id: null,
    user_message_uuid: 'prompt',
    message: { content: [{ type: 'text', text: 'stale refusal' }] },
  } as unknown as SDKMessage);
  const stream = (event: unknown) =>
    ({
      type: 'stream_event',
      parent_tool_use_id: null,
      user_message_uuid: 'prompt',
      event,
    }) as SDKMessage;
  project(stream({ type: 'message_start' }));
  project(
    stream({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'live replacement' },
    }),
  );
  project({
    type: 'system',
    subtype: 'model_refusal_fallback',
    retracted_message_uuids: ['stale'],
  } as SDKMessage);
  activity.close();
  const events = [];
  for await (const event of activity.events) events.push(event);
  expect(events.at(-1)).toEqual({
    type: EventType.MESSAGES_SNAPSHOT,
    messages: [{ id: expect.any(String), role: 'assistant', content: 'live replacement' }],
  });
});

it('the sole session reader publishes supersession while the native receipt and writer remain pending', async () => {
  const input = createInputStream();
  const frames = Array.from({ length: 4 }, () => Promise.withResolvers<SDKMessage>());
  const source = (async function* () {
    for (const frame of frames) yield await frame.promise;
  })();
  const query = Object.assign(source, { close() {}, async interrupt() {} }) as unknown as Query;
  const session = createClaudeSession({ query, nativeSessionId: 'session' }, input);
  const run = await session.run({ content: [] });
  const submitted = await input.prompt[Symbol.asyncIterator]().next();
  const promptId = submitted.value.uuid;
  const events = run.events[Symbol.asyncIterator]();
  await events.next();
  frames[0]?.resolve({
    type: 'stream_event',
    parent_tool_use_id: null,
    user_message_uuid: promptId,
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'stale refusal' },
    },
  } as SDKMessage);
  expect((await events.next()).value).toMatchObject({ type: EventType.TEXT_MESSAGE_START });
  expect((await events.next()).value).toMatchObject({ delta: 'stale refusal' });
  const assistant = (uuid: string, content: string, extra = {}) =>
    ({
      type: 'assistant',
      uuid,
      parent_tool_use_id: null,
      user_message_uuid: promptId,
      message: { content: [{ type: 'text', text: content }] },
      ...extra,
    }) as unknown as SDKMessage;
  frames[1]?.resolve(assistant('stale', 'stale refusal'));
  await events.next(); // closes the native partial
  expect((await events.next()).value).toMatchObject({ type: EventType.MESSAGES_SNAPSHOT });
  frames[2]?.resolve(assistant('answer', 'correct answer', { supersedes: ['stale'] }));
  expect((await events.next()).value).toEqual({
    type: EventType.MESSAGES_SNAPSHOT,
    messages: [{ id: 'answer', role: 'assistant', content: 'correct answer' }],
  });
  let settled = false;
  void run.result.then(() => {
    settled = true;
  });
  await expect(session.run({ content: [] })).rejects.toThrow('active run');
  expect(settled).toBe(false);
  const native = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    user_message_uuid: promptId,
    result: 'correct answer',
  } as SDKMessage;
  frames[3]?.resolve(native);
  const receipt = await run.result;
  expect(receipt.native).toBe(native);
  expect(receipt.messages).toEqual([
    { id: 'answer', role: 'assistant', content: 'correct answer' },
  ]);
  expect((await events.next()).value).toMatchObject({ type: EventType.RUN_FINISHED });
  await session.dispose();
});
