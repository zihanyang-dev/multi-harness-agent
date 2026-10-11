import { EventType } from '@ag-ui/core';
import type {
  AgentSession,
  AgentSessionEvent,
  SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';
import { createActivityChannel } from '../activity-channel.js';
import { createRunEvents, subscribeRun, toMessages } from './projection.js';

it('publishes genuine pending text and process without exposing thinking or failing native callbacks', async () => {
  let callback!: (event: AgentSessionEvent) => void;
  const session = {
    subscribe(fn: typeof callback) {
      callback = fn;
      return () => {};
    },
  } as AgentSession;
  const channel = createActivityChannel();
  subscribeRun(session, () => {}, channel);
  callback({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
  } as AgentSessionEvent);
  expect((await channel.events.next()).value).toMatchObject({ type: 'TEXT_MESSAGE_START' });
  expect((await channel.events.next()).value).toMatchObject({
    type: 'TEXT_MESSAGE_CONTENT',
    delta: 'Hello',
  });
  callback({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_start' },
  } as AgentSessionEvent);
  expect((await channel.events.next()).value).toEqual({
    type: 'CUSTOM',
    name: 'reasoning',
    value: { status: 'started' },
  });
  for (let i = 0; i < 300; i++)
    expect(() =>
      callback({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'x' },
      } as AgentSessionEvent),
    ).not.toThrow();
});

it('does not promote cancelled native text into the formal history receipt', () => {
  const entries = [
    {
      type: 'message',
      id: 'aborted',
      message: {
        role: 'assistant',
        stopReason: 'aborted',
        content: [{ type: 'text', text: 'unfinished' }],
      },
    },
  ] as unknown as SessionEntry[];
  expect(toMessages(entries, new Set())).toEqual([]);
});

it('uses generic tool outcomes by default and permits only bounded host-opted-in text', async () => {
  for (const publicTools of [[], ['search']]) {
    let callback!: (event: AgentSessionEvent) => void;
    const session = {
      subscribe(fn: typeof callback) {
        callback = fn;
        return () => {};
      },
    } as AgentSession;
    const channel = createActivityChannel();
    subscribeRun(
      session,
      () => {
        throw new Error('observer failure');
      },
      channel,
      publicTools,
    );
    expect(() => callback({ type: 'agent_start' })).not.toThrow();
    callback({
      type: 'tool_execution_start',
      toolCallId: 'call',
      toolName: 'search',
      args: { secret: 'private args' },
    });
    expect((await channel.events.next()).value).toEqual({
      type: 'TOOL_CALL_START',
      toolCallId: 'call',
      toolCallName: 'search',
    });
    expect((await channel.events.next()).value).toEqual({
      type: 'TOOL_CALL_END',
      toolCallId: 'call',
    });
    callback({
      type: 'tool_execution_end',
      toolCallId: 'call',
      toolName: 'search',
      isError: false,
      result: {
        content: [{ type: 'text', text: 'x'.repeat(9000) }],
        details: { secret: 'private details' },
      },
    });
    expect((await channel.events.next()).value).toMatchObject({
      type: 'TOOL_CALL_RESULT',
      content: publicTools.length ? 'x'.repeat(8192) : 'Tool finished.',
      role: 'tool',
    });
    callback({
      type: 'tool_execution_end',
      toolCallId: 'call',
      toolName: 'search',
      isError: true,
      result: { content: [{ type: 'text', text: 'private failure' }] },
    });
    expect((await channel.events.next()).value).toMatchObject({ content: 'Tool failed.' });
  }
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
