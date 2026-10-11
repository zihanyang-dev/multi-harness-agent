import { setTimeout } from 'node:timers/promises';
import type { Database } from '@multi-harness/database';
import {
  EXECUTE_TURN_JOB_NAME,
  type ExecuteTurnJob,
  TURN_QUEUE_NAME,
} from '@multi-harness/protocol/execution';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { advanceDelivery, notePublished, reserveDeliveries } from '../db/command-publication.js';

/** Queue owns notifications only; completed jobs are not canonical product outcomes. */
export function createCommandQueue(connection: Redis, prefix: string): Queue<ExecuteTurnJob> {
  return new Queue<ExecuteTurnJob>(TURN_QUEUE_NAME, {
    connection,
    prefix,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 86400, count: 1000 },
      removeOnFail: { age: 604800, count: 1000 },
    },
  });
}

/** Publishes until cancellation; callers own the database, queue and awaiting this task. */
export async function publishCommands(
  database: Database,
  queue: Queue<ExecuteTurnJob>,
  signal: AbortSignal,
  logger: Logger,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await publishDueTurns(database, queue);
    } catch {
      // Do not expose SQL, broker credentials or payloads through background diagnostics.
      logger.error({ code: 'command_publication_failed' }, 'Command publication failed');
    }
    if (signal.aborted) return;
    try {
      await setTimeout(1000, undefined, { signal });
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
  }
}

/** Redis IO follows committed reservations; even a lost enqueue response remains rediscoverable. */
export async function publishDueTurns(
  database: Database,
  queue: Queue<ExecuteTurnJob>,
): Promise<void> {
  const deliveries = await reserveDeliveries(database, { limit: 20, redeliveryDelayMs: 10000 });
  let failed = false;
  for (let delivery of deliveries) {
    try {
      let jobId = `turn-${delivery.turnId}-${delivery.generation}`;
      const existing = await queue.getJob(jobId);
      if (existing !== undefined) {
        const state = await existing.getState();
        if (state === 'completed' || state === 'failed') {
          const next = await advanceDelivery(database, delivery);
          if (next === undefined) continue;
          delivery = next;
          jobId = `turn-${delivery.turnId}-${delivery.generation}`;
        }
      }
      await queue.add(EXECUTE_TURN_JOB_NAME, { turnId: delivery.turnId }, { jobId });
      await notePublished(database, delivery);
    } catch {
      // A delivery-local fault must not starve the rest of this committed reservation.
      failed = true;
    }
  }
  if (failed) throw new Error('command_publication_failed');
}
