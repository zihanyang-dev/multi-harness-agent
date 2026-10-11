import {
  type AssistantMessage,
  type BaseEvent,
  EventType,
  type Message,
  type RunFinishedOutcome,
} from '@ag-ui/core';
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

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

      // Wire UUID identifies a block; API message.id may be shared by several blocks.
      for (const uuid of message.supersedes ?? []) observation.messages.delete(uuid);
      if (message.aborted) observation.aborted = true;
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

/** Observes settled full text without borrowing or closing the persistent native reader. */
export async function* createRunEvents(options: {
  threadId: string;
  runId: string;
  result: Promise<HarnessTurnResult>;
}): AsyncGenerator<BaseEvent> {
  const identity = { threadId: options.threadId, runId: options.runId };
  void options.result.catch(() => undefined);
  yield { type: EventType.RUN_STARTED, ...identity };

  let result: HarnessTurnResult;
  try {
    result = await options.result;
  } catch {
    yield { type: EventType.RUN_ERROR, message: 'Claude run failed' };
    return;
  }

  // Execution has already settled. Display failure must not replace its private receipt.
  try {
    yield* toMessageEvents(result.messages);
    yield { type: EventType.RUN_FINISHED, ...identity, outcome: toRunOutcome(result.status) };
  } catch {
    yield { type: EventType.RUN_ERROR, message: 'Claude event observation failed' };
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
