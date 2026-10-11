import { setTimeout as delay } from 'node:timers/promises';
import type { Database } from '@multi-harness/database';
import { turnActivityKey } from '@multi-harness/protocol/execution';
import { ActivityEnvelopeSchema, type Turn } from '@multi-harness/protocol/http';
import type { SSEStreamingApi } from 'hono/streaming';
import type { Redis } from 'ioredis';
import { getTurn } from '../db/conversation-history.js';

export interface ActivityStreamOptions {
  connection: Redis;
  prefix: string;
  shutdown: AbortSignal;
}

// Redis components are unsigned 64-bit integers; never compare IDs lexically.
export function validActivityCursor(cursor: string): boolean {
  return (
    /^\d{1,20}-\d{1,20}$/.test(cursor) &&
    cursor.split('-').every((part) => BigInt(part) <= 18446744073709551615n)
  );
}
function compare(left: string, right: string): number {
  const [lm, ls] = left.split('-').map(BigInt) as [bigint, bigint];
  const [rm, rs] = right.split('-').map(BigInt) as [bigint, bigint];
  if (lm !== rm) return lm < rm ? -1 : 1;
  if (ls === rs) return 0;
  return ls < rs ? -1 : 1;
}
function before(id: string): string {
  const [ms, seq] = id.split('-').map(BigInt) as [bigint, bigint];
  return seq > 0n ? `${ms}-${seq - 1n}` : `${ms - 1n}-18446744073709551615`;
}
function settled(turn: Turn): boolean {
  return turn.status !== 'accepted' && turn.status !== 'running';
}

// Metadata and the bounded, nonblocking read must see the same retention boundary.
// IDs remain strings: Lua numbers cannot represent Redis's 64-bit ID components.
const readActivity = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return {'', '', 0, {}}
end
local info = redis.call('XINFO', 'STREAM', KEYS[1])
local first, last, length, added = '', '', 0, 0
for i = 1, #info, 2 do
  if info[i] == 'first-entry' and info[i + 1] then first = info[i + 1][1] end
  if info[i] == 'last-entry' and info[i + 1] then last = info[i + 1][1] end
  if info[i] == 'length' then length = info[i + 1] end
  if info[i] == 'entries-added' then added = info[i + 1] end
end
local batches = redis.call('XREAD', 'COUNT', 100, 'STREAMS', KEYS[1], ARGV[1])
return {first, last, added > length and 1 or 0, batches and batches[1][2] or {}}
`;

/** Observation only: SQL owns lifecycle, Redis owns disposable ordered display activity. */
export async function streamTurnActivity(
  stream: SSEStreamingApi,
  options: ActivityStreamOptions & {
    database: Database;
    request: Request;
    ownerId: string;
    turn: Turn;
    cursor: string;
    getOwnerId: (request: Request) => Promise<string | undefined>;
    disconnect?: () => void;
  },
): Promise<void> {
  const observer = new AbortController();
  const signal = AbortSignal.any([observer.signal, options.shutdown, options.request.signal]);
  const abort = () => {
    // The Node adapter can be waiting for outgoing drain even after stream.abort().
    // Release only this observer's HTTP transport, never its execution.
    options.disconnect?.();
    stream.abort();
  };
  signal.addEventListener('abort', abort, { once: true });
  stream.onAbort(() => observer.abort());
  const write = async (event: string, data: unknown, id?: string) => {
    if (signal.aborted) return;
    // A slow browser must not hold the HTTP shutdown join indefinitely.
    const timer = setTimeout(() => observer.abort(), 1000);
    try {
      await stream.writeSSE({
        event,
        data: JSON.stringify(data),
        retry: 2000,
        ...(id === undefined ? {} : { id }),
      });
    } finally {
      clearTimeout(timer);
    }
  };
  const gap = (code: 'activity_gap' | 'activity_unavailable') => write('gap', { code });
  let cursor = options.cursor;
  let fresh = cursor === '0-0';
  let replayEarliest: string | undefined;
  let nextSnapshot = Date.now() + 1000;
  const key = turnActivityKey(options.prefix, options.turn.id);
  const refresh = async (): Promise<boolean> => {
    if (signal.aborted) return false;
    if (Date.now() < nextSnapshot) return true;
    if ((await options.getOwnerId(options.request)) !== options.ownerId) return false;
    const turn = await getTurn(options.database, {
      ownerId: options.ownerId,
      turnId: options.turn.id,
    });
    if (turn === undefined || signal.aborted) return false;
    await write('turn', turn);
    if (settled(turn) || signal.aborted) return false;
    const timer = setTimeout(() => observer.abort(), 1000);
    try {
      await stream.write(': heartbeat\n\n');
    } finally {
      clearTimeout(timer);
    }
    nextSnapshot = Date.now() + 1000;
    return !signal.aborted;
  };
  try {
    if (signal.aborted) {
      abort();
      return;
    }
    await write('turn', options.turn);
    if (settled(options.turn) || signal.aborted) return;
    while (!signal.aborted) {
      if (!(await refresh())) return;
      try {
        const [earliest, latest, retentionLost, frames] = (await options.connection.eval(
          readActivity,
          1,
          key,
          cursor,
        )) as [string, string, number, [string, string[]][]];
        if (
          (fresh && retentionLost === 1) ||
          (cursor !== '0-0' &&
            (!earliest ||
              !latest ||
              (compare(cursor, earliest) < 0 && replayEarliest !== earliest) ||
              compare(cursor, latest) > 0))
        ) {
          await gap('activity_gap');
          fresh = false;
          cursor = earliest ? before(earliest) : '0-0';
          // A future cursor yields no frames; replay on the next atomic read.
          // A new trim boundary still reports a gap during that replay.
          replayEarliest = earliest || undefined;
        }
        for (const [id, fields] of frames) {
          if (!(await refresh())) return;
          if (!validActivityCursor(id) || compare(id, cursor) <= 0) {
            await gap('activity_gap');
            continue;
          }
          cursor = id;
          fresh = false;
          replayEarliest = undefined;
          if (fields.length === 2 && fields[0] === 'gap' && fields[1] === 'activity_unavailable') {
            await gap('activity_unavailable');
            continue;
          }
          let payload: unknown;
          try {
            if (
              fields.length !== 2 ||
              fields[0] !== 'activity' ||
              (fields[1]?.length ?? 0) > 256000
            )
              throw new Error('invalid_activity');
            payload = JSON.parse(fields[1] ?? '');
          } catch {
            await gap('activity_gap');
            continue;
          }
          const parsed = ActivityEnvelopeSchema.safeParse(payload);
          if (!parsed.success || parsed.data.turnId !== options.turn.id) {
            await gap('activity_gap');
            continue;
          }
          await write('activity', parsed.data, id);
        }
      } catch {
        if (!signal.aborted) await gap('activity_unavailable');
        return;
      }
      await delay(100, undefined, { signal });
    }
  } catch {
    // Never send database/auth exception details or native transport diagnostics.
    if (!signal.aborted) await gap('activity_unavailable');
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
