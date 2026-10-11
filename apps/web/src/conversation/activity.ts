import type { ActivityEnvelope, Turn } from '@multi-harness/protocol/http';

export type ActivityState = {
  turnId: string;
  messages: { id: string; text: string; ended: boolean }[];
  tools: { id: string; name: string; status: 'started' | 'finished'; result?: string }[];
  process: Partial<Record<'reasoning' | 'compaction' | 'retry', 'started' | 'finished'>>;
  missing: boolean;
  truncated: boolean;
  settled: boolean;
  cursor: string | null;
};
export type ActivityAction =
  | { kind: 'activity'; id: string; envelope: ActivityEnvelope }
  | { kind: 'gap' }
  | { kind: 'snapshot'; turnId: string; status: Turn['status'] };

export function emptyActivity(turnId: string): ActivityState {
  return {
    turnId,
    messages: [],
    tools: [],
    process: {},
    missing: false,
    truncated: false,
    settled: false,
    cursor: null,
  };
}

/** Bounded previews may be withdrawn; only public Turn snapshots decide settlement. */
export function reduceActivity(state: ActivityState, action: ActivityAction): ActivityState {
  if (action.kind === 'snapshot') {
    if (
      action.turnId !== state.turnId ||
      action.status === 'accepted' ||
      action.status === 'running'
    )
      return state;
    return { ...emptyActivity(state.turnId), cursor: state.cursor, settled: true };
  }
  if (state.settled) return state;
  if (action.kind === 'gap') {
    return { ...emptyActivity(state.turnId), cursor: state.cursor, missing: true };
  }
  if (action.envelope.turnId !== state.turnId || !/^\d+-\d+$/.test(action.id)) return state;
  if (state.cursor && compareCursor(action.id, state.cursor) <= 0) return state;
  const next = { ...state, cursor: action.id };
  const event = action.envelope.event;
  switch (event.type) {
    case 'MESSAGES_SNAPSHOT': {
      let remaining = 32000;
      next.truncated ||= event.messages.length > 32;
      next.messages = event.messages.slice(-32).map((message) => {
        const text = message.content.slice(0, remaining);
        remaining -= text.length;
        next.truncated ||= text.length < message.content.length;
        return { id: message.id, text, ended: false };
      });
      break;
    }
    case 'TEXT_MESSAGE_START':
      if (!state.messages.some((message) => message.id === event.messageId)) {
        next.messages = [...state.messages, { id: event.messageId, text: '', ended: false }].slice(
          -32,
        );
        next.truncated ||= state.messages.length >= 32;
      }
      break;
    case 'TEXT_MESSAGE_CONTENT': {
      const remaining = Math.max(
        0,
        32000 - state.messages.reduce((size, message) => size + message.text.length, 0),
      );
      next.messages = state.messages.map((message) =>
        message.id === event.messageId && !message.ended
          ? { ...message, text: message.text + event.delta.slice(0, remaining) }
          : message,
      );
      next.truncated ||= event.delta.length > remaining;
      break;
    }
    case 'TEXT_MESSAGE_END':
      next.messages = state.messages.map((message) =>
        message.id === event.messageId ? { ...message, ended: true } : message,
      );
      break;
    case 'TOOL_CALL_START':
      if (!state.tools.some((tool) => tool.id === event.toolCallId)) {
        next.tools = [
          ...state.tools,
          {
            id: event.toolCallId,
            name: event.toolCallName.slice(0, 200),
            status: 'started' as const,
          },
        ].slice(-32);
        next.truncated ||= state.tools.length >= 32;
      }
      break;
    case 'TOOL_CALL_END':
      next.tools = state.tools.map((tool) =>
        tool.id === event.toolCallId ? { ...tool, status: 'finished' } : tool,
      );
      break;
    case 'TOOL_CALL_RESULT':
      next.tools = state.tools.map((tool) =>
        tool.id === event.toolCallId ? { ...tool, result: event.content.slice(0, 4000) } : tool,
      );
      next.truncated ||= event.content.length > 4000;
      break;
    case 'CUSTOM':
      if (event.name === 'retry' && event.value.status === 'started') {
        next.messages = [];
        next.tools = [];
        next.process = {};
      }
      next.process = { ...next.process, [event.name]: event.value.status };
      break;
    default:
      return next;
  }
  return next;
}

function compareCursor(left: string, right: string): number {
  const [leftTime = 0n, leftSequence = 0n] = left.split('-').map(BigInt);
  const [rightTime = 0n, rightSequence = 0n] = right.split('-').map(BigInt);
  if (leftTime !== rightTime) return leftTime > rightTime ? 1 : -1;
  if (leftSequence === rightSequence) return 0;
  return leftSequence > rightSequence ? 1 : -1;
}
