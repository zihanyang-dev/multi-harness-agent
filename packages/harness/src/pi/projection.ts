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

import type { HarnessTurnResult } from '../contract.js';

export interface CreateRunEventsOptions {
  threadId: string;
  runId: string;
  result: Promise<HarnessTurnResult>;
}

interface RunObservation {
  lastAssistant: NativeAssistantMessage | undefined;
  aborted: boolean;
}

/** Captures native outcome facts independently of public event consumption. */
export function subscribeRun(
  session: AgentSession,
  onOperationStart: () => void,
): {
  observation: RunObservation;
  unsubscribe: () => void;
} {
  const observation: RunObservation = { lastAssistant: undefined, aborted: false };
  const unsubscribe = session.subscribe((event) =>
    observeEvent(event, observation, onOperationStart),
  );
  return { observation, unsubscribe };
}

/** Projects the native terminal observation only after its owned prompt has fulfilled. */
export function toRunStatus(observation: RunObservation): HarnessTurnResult['status'] {
  const message = observation.lastAssistant;
  if (observation.aborted || message?.stopReason === 'aborted') return 'cancelled';
  if (message?.stopReason === 'error')
    throw new Error(message.errorMessage ?? 'Pi run failed', { cause: message });
  if (message?.stopReason === 'deferred') return 'paused';
  return 'completed';
}

/** Observes settlement without driving or cancelling the native invocation. */
export async function* createRunEvents(options: CreateRunEventsOptions): AsyncGenerator<BaseEvent> {
  const identity = { threadId: options.threadId, runId: options.runId };
  void options.result.catch(() => undefined);
  yield { type: EventType.RUN_STARTED, ...identity };
  let terminal: Event;

  try {
    const result = await options.result;
    yield* toFinalMessageEvents(result.messages);
    terminal = { type: EventType.RUN_FINISHED, ...identity, outcome: toRunOutcome(result.status) };
  } catch {
    terminal = await options.result.then<Event, Event>(
      () => ({ type: EventType.RUN_ERROR, message: 'Pi event observation failed' }),
      () => ({ type: EventType.RUN_ERROR, message: 'Pi run failed' }),
    );
  }

  yield terminal;
}

/** Selects new non-error assistant text by native entry ID without rewriting history. */
export function toMessages(
  entries: readonly SessionEntry[],
  previousIds: ReadonlySet<string>,
): AssistantMessage[] {
  const messages: AssistantMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== 'message' || previousIds.has(entry.id)) continue;
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
      onOperationStart();
      return;
    case 'agent_settled':
      observation.aborted = event.aborted;
      return;
  }
}

function toTextMessage(
  entry: Extract<SessionEntry, { type: 'message' }>,
): AssistantMessage | undefined {
  if (entry.message.role !== 'assistant' || entry.message.stopReason === 'error') return undefined;
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
  }
}
