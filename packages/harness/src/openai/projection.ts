import { randomUUID } from 'node:crypto';
import {
  type AssistantMessage,
  type BaseEvent,
  type Event,
  EventType,
  type Message,
  type RunFinishedOutcome,
} from '@ag-ui/core';
import type { RunItem, RunMessageOutputItem, RunStreamEvent, StreamEvent } from '@openai/agents';

import type { HarnessTurnResult } from '../contract.js';

export interface CreateRunEventsOptions {
  threadId: string;
  runId: string;
  /** Execution owns settlement independently of event delivery. */
  result: Promise<HarnessTurnResult>;
  previousMessageIds?: ReadonlySet<string>;
}

type TextMessages = Map<string, 'open' | 'closed'>;
interface ProcessObservation {
  reasoning: boolean;
}

/** Observes a non-cancelling native iterator and waits for the execution result. */
export async function* createRunEvents(
  events: AsyncIterable<RunStreamEvent>,
  options: CreateRunEventsOptions,
): AsyncGenerator<BaseEvent> {
  const identity = { threadId: options.threadId, runId: options.runId };
  const messages: TextMessages = new Map();
  const process: ProcessObservation = { reasoning: false };
  // SDK run items accumulate across resumes; prior observations must not reopen on this attempt.
  for (const id of options.previousMessageIds ?? []) messages.set(id, 'closed');
  let terminal: Event;

  // Delivery may suspend before EOF; observe rejection without replacing the original result.
  void options.result.catch(() => undefined);
  yield { type: EventType.RUN_STARTED, ...identity };

  try {
    for await (const event of events) {
      yield* toEvents(event, messages, process);
    }

    // EOF does not prove SDK settlement; persistence or guardrails may still be pending.
    const result = await options.result;
    yield* toFinalMessageEvents(result.messages, messages);
    terminal = { type: EventType.RUN_FINISHED, ...identity, outcome: toRunOutcome(result.status) };
  } catch {
    // Observation cannot change execution. Wait for its outcome and keep private exceptions on result.
    terminal = await options.result.then<Event, Event>(
      () => ({ type: EventType.RUN_ERROR, message: 'OpenAI event observation failed' }),
      () => ({ type: EventType.RUN_ERROR, message: 'OpenAI run failed' }),
    );
  }

  // An interrupted stream may omit message completion; close observations before the terminal.
  for (const [messageId, status] of messages) {
    if (status === 'open') yield { type: EventType.TEXT_MESSAGE_END, messageId };
  }
  yield terminal;
}

/** Selects assistant text without changing the SDK's cumulative run items. */
export function toMessages(
  items: readonly RunItem[],
  previousMessageIds: ReadonlySet<string> = new Set(),
): AssistantMessage[] {
  const messages: AssistantMessage[] = [];
  // Deduplicate the public view only; leave cumulative native items available to the host.
  const seen = new Set(previousMessageIds);
  for (const item of items) {
    if (item.type !== 'message_output_item') continue;
    const message = toTextMessage(item);
    if (message === undefined || seen.has(message.id)) continue;
    seen.add(message.id);
    messages.push(message);
  }
  return messages;
}

function toEvents(
  event: RunStreamEvent,
  messages: TextMessages,
  process: ProcessObservation,
): Event[] {
  // Route SDK event families here; each converter owns its full observation transition.
  switch (event.type) {
    case 'raw_model_stream_event':
      return toModelEvents(event.data, messages, process);
    case 'run_item_stream_event':
      return toItemEvents(event.item, messages);
    case 'agent_updated_stream_event':
      return [];
  }
}

function toModelEvents(
  data: StreamEvent,
  messages: TextMessages,
  process: ProcessObservation,
): Event[] {
  // Raw reasoning and public summaries share SDK routing. Observe lifecycle only, never text.
  if (data.type === 'model') {
    const type: unknown = data.event?.type;
    if (
      type === 'response.reasoning_text.delta' ||
      type === 'response.reasoning_summary_text.delta'
    ) {
      if (process.reasoning) return [];
      process.reasoning = true;
      return [{ type: EventType.CUSTOM, name: 'reasoning', value: { status: 'started' } }];
    }
    if (
      type === 'response.reasoning_text.done' ||
      type === 'response.reasoning_summary_text.done'
    ) {
      if (!process.reasoning) return [];
      process.reasoning = false;
      return [{ type: EventType.CUSTOM, name: 'reasoning', value: { status: 'finished' } }];
    }
    return [];
  }
  // Use normalized SDK text deltas, not provider-specific frames or hidden model metadata.
  if (data.type !== 'output_text_delta' || data.delta === '') return [];
  const messageId = data.itemId;
  if (messageId === undefined || messageId.trim() === '') return [];
  const status = messages.get(messageId);
  if (status === 'closed') return [];

  const content: Event = { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: data.delta };
  if (status === 'open') return [content];

  messages.set(messageId, 'open');
  return [{ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' }, content];
}

function toItemEvents(item: RunItem, messages: TextMessages): Event[] {
  if (item.type === 'tool_call_item' && item.rawItem.type === 'function_call') {
    const { callId: toolCallId, name: toolCallName } = item.rawItem;
    return [
      { type: EventType.TOOL_CALL_START, toolCallId, toolCallName },
      { type: EventType.TOOL_CALL_END, toolCallId },
    ];
  }
  if (item.type === 'tool_call_output_item' && item.executionStatus === 'executed') {
    return [
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: randomUUID(),
        toolCallId: item.rawItem.callId,
        content: 'Tool finished.',
        role: 'tool',
      },
    ];
  }
  if (item.type === 'compaction_item') {
    return [{ type: EventType.CUSTOM, name: 'compaction', value: { status: 'finished' } }];
  }
  if (item.type !== 'message_output_item') return [];
  const message = toTextMessage(item);
  const messageId = item.rawItem.id;
  if (messageId === undefined) return [];
  const status = messages.get(messageId);
  if (status === 'closed') return [];

  // A completed item closes streamed text without replaying its full content.
  const end: Event = { type: EventType.TEXT_MESSAGE_END, messageId };
  if (status === 'open') {
    messages.set(messageId, 'closed');
    return [end];
  }
  if (message === undefined) return [];

  messages.set(messageId, 'closed');
  return [
    { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: message.content },
    end,
  ];
}

function toFinalMessageEvents(items: readonly Message[], messages: TextMessages): Event[] {
  // Some SDK paths emit only final items. Fill unseen messages, never replay partial streamed text.
  const events: Event[] = [];
  for (const item of items) {
    if (item.role !== 'assistant' || typeof item.content !== 'string' || item.content === '')
      continue;
    const messageId = item.id;
    if (messageId.trim() === '' || messages.has(messageId)) continue;
    messages.set(messageId, 'open');
    events.push({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' });
    events.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: item.content });
  }
  return events;
}

function toTextMessage(item: RunMessageOutputItem) {
  // Native IDs are optional. Unidentified content stays native; display cannot invalidate execution.
  const id = item.rawItem.id;
  if (id === undefined || id.trim() === '') return undefined;

  // Refusals are visible text; keep other native content and metadata out of this projection.
  let content = '';
  for (const part of item.rawItem.content) {
    if (part.type === 'output_text') content += part.text;
    if (part.type === 'refusal') content += part.refusal;
  }
  if (content === '') return undefined;
  return { id, role: 'assistant' as const, content };
}

function toRunOutcome(status: HarnessTurnResult['status']): RunFinishedOutcome {
  switch (status) {
    case 'completed':
      return { type: 'success' };
    case 'cancelled':
      return { type: 'cancelled' };
    case 'paused':
      // Approval details belong to the trusted native receipt, not a public interrupt payload.
      return { type: 'interrupt', interrupts: [] };
  }
}
