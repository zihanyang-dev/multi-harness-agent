import { randomUUID } from 'node:crypto';
import {
  type AssistantMessage,
  type BaseEvent,
  type Event,
  EventType,
  type Message,
  type RunFinishedOutcome,
} from '@ag-ui/core';
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ActivityChannel } from '../activity-channel.js';

import type { HarnessTurnResult } from '../contract.js';

export interface RunObservation {
  messages: Map<string, AssistantMessage>;
  aborted: boolean;
}

/** Records native display facts and returns only the current submission's terminal receipt. */
export function observeMessage(
  message: SDKMessage,
  observation: RunObservation,
  promptId: string,
): SDKResultMessage | undefined {
  switch (message.type) {
    case 'system':
      if (message.subtype === 'model_refusal_fallback') {
        for (const uuid of message.retracted_message_uuids ?? []) observation.messages.delete(uuid);
      }
      return;

    case 'assistant': {
      // Nested replies stay with their native subagent, not this turn's public display.
      if (message.parent_tool_use_id !== null) return;
      const ids =
        message.user_message_uuids ??
        (message.user_message_uuid === undefined ? undefined : [message.user_message_uuid]);
      if (ids !== undefined && (ids.length !== 1 || ids[0] !== promptId)) return;

      // Wire UUID identifies a block; API message.id may be shared by several blocks.
      for (const uuid of message.supersedes ?? []) observation.messages.delete(uuid);
      if (message.aborted) {
        observation.aborted = true;
        return;
      }
      if (message.error !== undefined) return;

      let content = '';
      for (const block of message.message.content) {
        if (block.type === 'text') content += block.text;
      }
      if (content !== '') {
        observation.messages.set(message.uuid, { id: message.uuid, role: 'assistant', content });
      }
      return;
    }

    case 'result': {
      // Older producers may echo only one UUID. Missing attribution must still fail closed.
      const promptIds = message.user_message_uuids ?? [message.user_message_uuid];
      if (
        promptIds.length !== 1 ||
        promptIds[0] !== promptId ||
        (message.queued_turn_count ?? 0) > 0
      )
        throw new Error('Claude native result attribution changed');
      return message;
    }

    default:
      return;
  }
}

/** Classifies the native outcome, independently of whether interruption was requested. */
export function toRunStatus(
  native: SDKResultMessage,
  observation: RunObservation,
): HarnessTurnResult['status'] {
  // Native abort is authoritative even when the receipt also carries an error payload.
  if (native.terminal_reason === 'aborted_streaming' || native.terminal_reason === 'aborted_tools')
    return 'cancelled';

  if (native.subtype !== 'success')
    throw new Error(native.errors.join('\n') || 'Claude run failed', { cause: native });
  if (native.is_error) throw new Error(native.result || 'Claude run failed', { cause: native });

  if (native.terminal_reason === 'tool_deferred') return 'paused';
  if (native.terminal_reason === undefined && observation.aborted) return 'cancelled';
  return 'completed';
}

/** Observes native partial activity, with settled-text fallback, without borrowing the reader. */
export function createRunEvents(options: {
  threadId: string;
  runId: string;
  result: Promise<HarnessTurnResult>;
  activity?: ActivityChannel;
}): AsyncGenerator<BaseEvent> {
  const events = observeRunEvents(options);
  const finish = events.return.bind(events);
  events.return = async (value) => {
    await options.activity?.events.return?.();
    return finish(value);
  };
  return events;
}

async function* observeRunEvents(
  options: Parameters<typeof createRunEvents>[0],
): AsyncGenerator<BaseEvent> {
  const identity = { threadId: options.threadId, runId: options.runId };
  void options.result.catch(() => undefined);
  try {
    yield { type: EventType.RUN_STARTED, ...identity };

    let result: HarnessTurnResult;
    let streamed = false;
    let snapshotted = false;
    try {
      if (options.activity !== undefined) {
        for await (const event of options.activity.events) {
          if (event.type === EventType.TEXT_MESSAGE_CONTENT) streamed = true;
          if (event.type === EventType.MESSAGES_SNAPSHOT) snapshotted = true;
          yield event;
        }
      }
      if (options.activity?.abandoned) return;
      const settled = await Promise.race([
        options.result,
        ...(options.activity === undefined ? [] : [options.activity.abandonedPromise]),
      ]);
      if (options.activity?.abandoned || settled === undefined) return;
      result = settled;
    } catch {
      const failure = options.result.then(
        () => 'Claude event observation failed',
        () => 'Claude run failed',
      );
      const message = await Promise.race([
        failure,
        ...(options.activity === undefined ? [] : [options.activity.abandonedPromise]),
      ]);
      if (options.activity?.abandoned || message === undefined) return;
      yield { type: EventType.RUN_ERROR, message };
      return;
    }

    // Execution has already settled. Display failure must not replace its private receipt.
    try {
      if (!streamed) {
        // Snapshot-only observations must not be concatenated again by the text fallback.
        if (snapshotted) yield { type: EventType.MESSAGES_SNAPSHOT, messages: [] };
        yield* toMessageEvents(result.messages);
      }
      yield { type: EventType.RUN_FINISHED, ...identity, outcome: toRunOutcome(result.status) };
    } catch {
      yield { type: EventType.RUN_ERROR, message: 'Claude event observation failed' };
    }
  } finally {
    await options.activity?.events.return?.();
  }
}

function* toMessageEvents(messages: readonly Message[]): Generator<BaseEvent> {
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const content = message.content;
    if (typeof content !== 'string' || content === '') continue;

    yield { type: EventType.TEXT_MESSAGE_START, messageId: message.id, role: 'assistant' };
    yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: message.id, delta: content };
    yield { type: EventType.TEXT_MESSAGE_END, messageId: message.id };
  }
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

/** Public partial observation is fenced separately from the authoritative receipt/history. */
export function createActivityProjector(
  activity: ActivityChannel,
  promptId: string,
  observation?: RunObservation,
) {
  // Production shares the sole reader's already-updated display facts. Standalone
  // projectors retain only the same public text map, never native SDK graphs.
  const display = observation ?? { messages: new Map<string, AssistantMessage>(), aborted: false };
  let partial = '';
  let attributed = false;
  let retryPending = false;
  let messageId: string | undefined;
  const blocks = new Map<number, { toolCallId?: string; thinking?: boolean }>();
  const emit = (event: Event) => activity.push(event);
  const process = (name: 'reasoning' | 'compaction' | 'retry', status: 'started' | 'finished') =>
    emit({ type: EventType.CUSTOM, name, value: { status } });
  const snapshot = () => {
    let remaining = 32000;
    const messages = [...display.messages.values()].slice(-128).map((message) => {
      const content =
        typeof message.content === 'string' ? message.content.slice(0, remaining) : '';
      remaining -= content.length;
      return { id: message.id.slice(0, 200), role: 'assistant' as const, content };
    });
    if (messageId !== undefined && partial !== '') {
      if (messages.length === 128) messages.shift();
      messages.push({ id: messageId, role: 'assistant', content: partial.slice(0, remaining) });
    }
    emit({ type: EventType.MESSAGES_SNAPSHOT, messages });
  };
  const closeText = () => {
    if (messageId !== undefined) emit({ type: EventType.TEXT_MESSAGE_END, messageId });
    messageId = undefined;
    partial = '';
  };
  return (message: SDKMessage): void => {
    // A display error must not escape the sole native reader or replace its result.
    try {
      if (message.type === 'assistant') {
        if (message.parent_tool_use_id !== null) return;
        const ids =
          message.user_message_uuids ??
          (message.user_message_uuid === undefined ? undefined : [message.user_message_uuid]);
        if (ids !== undefined && (ids.length !== 1 || ids[0] !== promptId)) return;
        if (observation === undefined) observeMessage(message, display, promptId);
        closeText();
        snapshot();
        return;
      }
      if (message.type === 'system' && message.subtype === 'model_refusal_fallback') {
        if (observation === undefined) observeMessage(message, display, promptId);
        snapshot();
        return;
      }
      if (message.type === 'stream_event') {
        if (message.parent_tool_use_id !== null) return;
        const ids =
          message.user_message_uuids ??
          (message.user_message_uuid === undefined ? undefined : [message.user_message_uuid]);
        if (ids !== undefined) attributed = ids.length === 1 && ids[0] === promptId;
        if (!attributed) return;
        if (retryPending) {
          process('retry', 'finished');
          retryPending = false;
        }
        const event = message.event;
        switch (event.type) {
          case 'message_start':
            closeText();
            blocks.clear();
            return;
          case 'content_block_start': {
            const block = event.content_block;
            if (block.type === 'tool_use') {
              if (blocks.size >= 256) return;
              blocks.set(event.index, { toolCallId: block.id });
              emit({
                type: EventType.TOOL_CALL_START,
                toolCallId: block.id,
                toolCallName: block.name,
              });
            }
            if (block.type === 'thinking') {
              if (blocks.size >= 256) return;
              blocks.set(event.index, { thinking: true });
              process('reasoning', 'started');
            }
            return;
          }
          case 'content_block_delta':
            if (event.delta.type !== 'text_delta' || event.delta.text === '') return;
            if (messageId === undefined) {
              messageId = randomUUID();
              emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' });
            }
            partial += event.delta.text.slice(0, 32000 - partial.length);
            emit({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId,
              delta: event.delta.text,
            });
            return;
          case 'content_block_stop': {
            const block = blocks.get(event.index);
            if (block?.toolCallId !== undefined)
              emit({ type: EventType.TOOL_CALL_END, toolCallId: block.toolCallId });
            if (block?.thinking) process('reasoning', 'finished');
            blocks.delete(event.index);
            return;
          }
          case 'message_stop':
            closeText();
            return;
          default:
            return; // Other native partial frames carry no public display facts.
        }
      }
      if (
        message.type === 'user' &&
        attributed &&
        message.parent_tool_use_id === null &&
        Array.isArray(message.message.content)
      ) {
        for (const block of message.message.content) {
          if (block.type !== 'tool_result') continue;
          emit({
            type: EventType.TOOL_CALL_RESULT,
            messageId: randomUUID(),
            toolCallId: block.tool_use_id,
            content: block.is_error ? 'Tool failed.' : 'Tool finished.',
            role: 'tool',
          });
        }
      }
      if (message.type === 'result') {
        closeText();
        blocks.clear();
      }
      if (message.type === 'system') {
        if (message.subtype === 'status' && message.status === 'compacting')
          process('compaction', 'started');
        if (message.subtype === 'compact_boundary') process('compaction', 'finished');
        if (message.subtype === 'api_retry' && !retryPending) {
          process('retry', 'started');
          retryPending = true;
        }
      }
    } catch {
      /* observation is never native execution */
    }
  };
}
