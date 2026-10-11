import { type BaseEvent, EventType } from '@ag-ui/core';
import type { HarnessRun } from '@multi-harness/harness';
import { turnActivityKey } from '@multi-harness/protocol/execution';
import { ActivityEnvelopeSchema } from '@multi-harness/protocol/http';
import type { Redis } from 'ioredis';

const appendActivity = `
  local id = redis.call('XADD', KEYS[1], 'MAXLEN', '~', 2048, '*', ARGV[1], ARGV[2])
  redis.call('EXPIRE', KEYS[1], 86400)
  return id
`;

/** Observes once without owning execution; transport failure leaves an explicit replay gap. */
export async function publishRunActivity(
  run: HarnessRun,
  options: { turnId: string; connection: Redis; prefix: string; signal: AbortSignal },
): Promise<void> {
  const { turnId, connection, prefix } = options;
  const key = turnActivityKey(prefix, turnId);
  const drain = new AbortController();
  const signal = AbortSignal.any([options.signal, drain.signal]);
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const beginDrain = () => {
    if (!closed) timer = setTimeout(() => drain.abort(), 250);
  };
  void run.result.then(beginDrain, beginDrain);
  try {
    for await (const event of run.events) {
      // The adapter closes observation at settlement. Do not drain a slow transport forever.
      // Production bounds each in-flight command to 1s; at most one gap write follows it.
      if (signal.aborted) throw new Error('activity_drain_expired');
      if (event.type === EventType.RUN_ERROR) throw new Error('activity_observation_failed');
      if (!isPublicActivity(event)) continue;
      const envelope = ActivityEnvelopeSchema.parse({ turnId, event });
      await connection.eval(appendActivity, 1, key, 'activity', JSON.stringify(envelope));
    }
  } catch {
    // A missing delta cannot be repaired by replaying a possibly committed XADD.
    // One bounded marker attempt is sufficient; SQL will still reconcile the formal result.
    try {
      await connection.eval(appendActivity, 1, key, 'gap', 'activity_unavailable');
    } catch {
      // An unavailable observer must never cancel, retry or fail the native invocation.
    }
  } finally {
    closed = true;
    clearTimeout(timer);
  }
}

function isPublicActivity(event: BaseEvent): boolean {
  switch (event.type) {
    case EventType.MESSAGES_SNAPSHOT:
    case EventType.TEXT_MESSAGE_START:
    case EventType.TEXT_MESSAGE_CONTENT:
    case EventType.TEXT_MESSAGE_END:
    case EventType.TOOL_CALL_START:
    case EventType.TOOL_CALL_END:
    case EventType.TOOL_CALL_RESULT:
    case EventType.CUSTOM:
      return true;
    default:
      // Native completion is not the product terminal state or a PostgreSQL commit receipt.
      return false;
  }
}
