import { randomUUID } from 'node:crypto';
import {
  type AssistantMessage,
  type BaseEvent,
  type Event,
  EventType,
  type Message,
  type RunFinishedOutcome,
} from '@ag-ui/core';
import type { AssistantMessage as NativeAssistantMessage } from '@earendil-works/pi-ai';
import type {
  AgentSession,
  AgentSessionEvent,
  SessionEntry,
} from '@earendil-works/pi-coding-agent';
import type { ActivityChannel } from '../activity-channel.js';

import type { HarnessTurnResult } from '../contract.js';

export interface CreateRunEventsOptions {
  threadId: string;
  runId: string;
  result: Promise<HarnessTurnResult>;
  activity?: ActivityChannel;
}

interface RunObservation {
  lastAssistant: NativeAssistantMessage | undefined;
  aborted: boolean;
}

/** Captures native outcome facts independently of public event consumption. */
export function subscribeRun(
  session: AgentSession,
  onOperationStart: () => void,
  activity?: ActivityChannel,
  publicTools: readonly string[] = [],
): {
  observation: RunObservation;
  unsubscribe: () => void;
} {
  const observation: RunObservation = { lastAssistant: undefined, aborted: false };
  let messageId: string | undefined;
  const emit = (event: Event) => activity?.push(event);
  const process = (name: 'reasoning' | 'compaction' | 'retry', status: 'started' | 'finished') =>
    emit({ type: EventType.CUSTOM, name, value: { status } });
  const unsubscribe = session.subscribe((event) => {
    // SDK listeners are not fail-isolated. Neither observation nor projection may escape.
    try {
      observeEvent(event, observation, onOperationStart);
    } catch {
      /* native owns execution */
    }
    try {
      if (event.type === 'message_update') {
        const delta = event.assistantMessageEvent;
        if (delta.type === 'text_delta' && delta.delta !== '') {
          if (messageId === undefined) {
            messageId = randomUUID();
            emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' });
          }
          emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: delta.delta });
        }
        if (delta.type === 'thinking_start') process('reasoning', 'started');
        if (delta.type === 'thinking_end') process('reasoning', 'finished');
      }
      if (
        event.type === 'message_end' &&
        event.message.role === 'assistant' &&
        messageId !== undefined
      ) {
        emit({ type: EventType.TEXT_MESSAGE_END, messageId });
        messageId = undefined;
      }
      if (event.type === 'compaction_start') process('compaction', 'started');
      if (event.type === 'compaction_end') process('compaction', 'finished');
      if (event.type === 'auto_retry_start') process('retry', 'started');
      if (event.type === 'auto_retry_end') process('retry', 'finished');
      if (event.type === 'tool_execution_start') {
        emit({
          type: EventType.TOOL_CALL_START,
          toolCallId: event.toolCallId,
          toolCallName: event.toolName,
        });
        // Call generation is complete before native execution starts.
        emit({ type: EventType.TOOL_CALL_END, toolCallId: event.toolCallId });
      }
      if (event.type === 'tool_execution_end') {
        let content = event.isError ? 'Tool failed.' : 'Tool finished.';
        if (!event.isError && publicTools.includes(event.toolName)) {
          const result = event.result as { content?: { type: string; text?: string }[] };
          let text = '';
          for (const part of result.content ?? []) {
            if (part.type === 'text') text += (part.text ?? '').slice(0, 8192 - text.length);
            if (text.length >= 8192) break;
          }
          content = text || content;
        }
        emit({
          type: EventType.TOOL_CALL_RESULT,
          messageId: randomUUID(),
          toolCallId: event.toolCallId,
          content,
          role: 'tool',
        });
      }
    } catch {
      /* public projection must never break prompt() */
    }
  });
  return { observation, unsubscribe };
}

/** Projects the native terminal observation only after its owned prompt has fulfilled. */
export function toRunStatus(observation: RunObservation): HarnessTurnResult['status'] {
  // prompt() can fulfil with an in-band failure, abort or deferred handle, or no model turn.
  const message = observation.lastAssistant;
  if (observation.aborted || message?.stopReason === 'aborted') return 'cancelled';
  if (message?.stopReason === 'error')
    throw new Error(message.errorMessage ?? 'Pi run failed', { cause: message });
  if (message?.stopReason === 'deferred') return 'paused';
  return 'completed';
}

/** Observes settlement without driving or cancelling the native invocation. */
export function createRunEvents(options: CreateRunEventsOptions): AsyncGenerator<BaseEvent> {
  const events = observeRunEvents(options);
  const finish = events.return.bind(events);
  events.return = async (value) => {
    await options.activity?.events.return?.();
    return finish(value);
  };
  return events;
}

async function* observeRunEvents(options: CreateRunEventsOptions): AsyncGenerator<BaseEvent> {
  const identity = { threadId: options.threadId, runId: options.runId };
  void options.result.catch(() => undefined);
  let terminal: Event;

  try {
    yield { type: EventType.RUN_STARTED, ...identity };
    let streamed = false;
    if (options.activity !== undefined) {
      for await (const event of options.activity.events) {
        if (event.type === EventType.TEXT_MESSAGE_CONTENT) streamed = true;
        yield event;
      }
    }
    if (options.activity?.abandoned) return;
    const result = await Promise.race([
      options.result,
      ...(options.activity === undefined ? [] : [options.activity.abandonedPromise]),
    ]);
    if (options.activity?.abandoned || result === undefined) return;
    if (!streamed) yield* toFinalMessageEvents(result.messages);
    terminal = { type: EventType.RUN_FINISHED, ...identity, outcome: toRunOutcome(result.status) };
  } catch {
    const failure = options.result.then<Event, Event>(
      () => ({ type: EventType.RUN_ERROR, message: 'Pi event observation failed' }),
      () => ({ type: EventType.RUN_ERROR, message: 'Pi run failed' }),
    );
    const observed = await Promise.race([
      failure,
      ...(options.activity === undefined ? [] : [options.activity.abandonedPromise]),
    ]);
    if (options.activity?.abandoned || observed === undefined) return;
    terminal = observed;
  } finally {
    await options.activity?.events.return?.();
  }

  yield terminal;
}

/** Selects new non-error assistant text by native entry ID without rewriting history. */
export function toMessages(
  entries: readonly SessionEntry[],
  previousEntryIds: ReadonlySet<string>,
): AssistantMessage[] {
  // Raw branch entries are display history, not the SDK's compacted/edited model context.
  const messages: AssistantMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== 'message' || previousEntryIds.has(entry.id)) continue;
    const message = toTextMessage(entry);
    if (message !== undefined) messages.push(message);
  }
  return messages;
}

function observeEvent(
  event: AgentSessionEvent,
  observation: RunObservation,
  onOperationStart: () => void,
): void {
  switch (event.type) {
    case 'message_end':
      if (event.message.role === 'assistant') observation.lastAssistant = event.message;
      return;
    case 'agent_start':
    case 'compaction_start':
      // Preflight compaction installs its abort target before the model loop starts.
      onOperationStart();
      return;
    case 'agent_settled':
      observation.aborted = event.aborted;
      return;
    default:
      return; // Other native events are not execution receipts.
  }
}

function toTextMessage(
  entry: Extract<SessionEntry, { type: 'message' }>,
): AssistantMessage | undefined {
  // Keep failures in native history without publishing retry fragments as successful answers.
  if (
    entry.message.role !== 'assistant' ||
    entry.message.stopReason === 'error' ||
    entry.message.stopReason === 'aborted'
  )
    return undefined;
  let content = '';
  for (const part of entry.message.content) {
    if (part.type === 'text') content += part.text;
  }
  if (content === '') return undefined;
  return { id: entry.id, role: 'assistant', content };
}

function toFinalMessageEvents(messages: readonly Message[]): Event[] {
  const events: Event[] = [];
  for (const message of messages) {
    if (
      message.role !== 'assistant' ||
      typeof message.content !== 'string' ||
      message.content === ''
    )
      continue;
    events.push({ type: EventType.TEXT_MESSAGE_START, messageId: message.id, role: 'assistant' });
    events.push({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: message.id,
      delta: message.content,
    });
    events.push({ type: EventType.TEXT_MESSAGE_END, messageId: message.id });
  }
  return events;
}

function toRunOutcome(status: HarnessTurnResult['status']): RunFinishedOutcome {
  switch (status) {
    case 'completed':
      return { type: 'success' };
    case 'cancelled':
      return { type: 'cancelled' };
    case 'paused':
      return { type: 'interrupt', interrupts: [] };
    default:
      throw new Error('Unsupported public run outcome');
  }
}
