import type { AssistantMessage, BaseEvent, Event } from '@ag-ui/core';
import { EventType } from '@ag-ui/core';
import type { RunItem, RunMessageOutputItem, RunStreamEvent, StreamEvent } from '@openai/agents';
import { extractAllTextOutput } from '@openai/agents';

import type { HarnessTurnResult } from '../contract.js';

export interface CreateRunEventsOptions {
  threadId: string;
  runId: string;
  /** The caller owns execution and settlement; this projection only observes the result. */
  result: Promise<HarnessTurnResult>;
}

/** Projects assistant text only; other native run items are outside this projection. */
export function toMessages(items: readonly RunItem[]): AssistantMessage[] {
  return items.filter((item) => item.type === 'message_output_item').map(toTextMessage);
}

/**
 * Observes text output and waits for the caller's settled result.
 * The caller supplies a non-cancelling iterator, such as stream.values({ preventCancel: true }).
 */
export async function* createRunEvents(
  events: AsyncIterable<RunStreamEvent>,
  options: CreateRunEventsOptions,
): AsyncIterable<BaseEvent> {
  const identity = { threadId: options.threadId, runId: options.runId };
  // Track unfinished messages locally; this observer does not own the native run.
  const openMessages = new Set<string>();
  let terminal: Event;

  // Observe rejection before yielding: slow or closed observers may never reach stream EOF.
  // The caller can still await the original promise and receive its failure.
  void options.result.catch(() => {});
  yield { type: EventType.RUN_STARTED, ...identity };

  try {
    for await (const event of events) {
      yield* toTextEvents(event, openMessages);
    }

    // Stream EOF can precede cleanup or persistence. Only the caller's result is terminal.
    const result = await options.result;
    const outcome = result.status === 'completed' ? 'success' : 'cancelled';
    terminal = { type: EventType.RUN_FINISHED, ...identity, outcome: { type: outcome } };
  } catch {
    // Wait for settlement without exposing upstream diagnostics in public events.
    // Observing this rejection leaves the caller's original result promise unchanged.
    await options.result.catch(() => {});
    terminal = { type: EventType.RUN_ERROR, message: 'OpenAI run failed' };
  }

  // Interrupted streams may omit final message items; close text before ending the run.
  for (const messageId of openMessages) {
    yield { type: EventType.TEXT_MESSAGE_END, messageId };
  }
  yield terminal;
}

function toTextEvents(event: RunStreamEvent, openMessages: Set<string>): Event[] {
  switch (event.type) {
    case 'raw_model_stream_event':
      return toTextDeltaEvents(event.data, openMessages);
    case 'run_item_stream_event':
      return toMessageEvents(event.item, openMessages);
    case 'agent_updated_stream_event':
      return [];
  }
}

function toTextDeltaEvents(data: StreamEvent, openMessages: Set<string>): Event[] {
  if (data.type !== 'output_text_delta' || !data.delta) return [];

  const messageId = requireId(data.itemId);
  const content: Event = { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: data.delta };
  if (openMessages.has(messageId)) return [content];

  openMessages.add(messageId);
  return [{ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' }, content];
}

function toMessageEvents(item: RunItem, openMessages: Set<string>): Event[] {
  if (item.type !== 'message_output_item') return [];

  const message = toTextMessage(item);
  const end: Event = { type: EventType.TEXT_MESSAGE_END, messageId: message.id };
  const wasStreaming = openMessages.delete(message.id);
  if (wasStreaming) return [end];

  // No deltas were observed, so publish the complete message once.
  const start: Event = {
    type: EventType.TEXT_MESSAGE_START,
    messageId: message.id,
    role: 'assistant',
  };
  if (!message.content) return [start, end];

  const content: Event = {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: message.id,
    delta: message.content,
  };
  return [start, content, end];
}

function toTextMessage(item: RunMessageOutputItem): AssistantMessage {
  return {
    id: requireId(item.rawItem.id),
    role: 'assistant',
    content: extractAllTextOutput([item]),
  };
}

function requireId(id: string | undefined): string {
  if (id === undefined) throw new Error('OpenAI text output is missing a native message ID');
  return id;
}
