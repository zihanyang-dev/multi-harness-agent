import type { Database } from '@multi-harness/database';
import {
  EXECUTE_TURN_JOB_NAME,
  type ExecuteTurnJob,
  ExecuteTurnJobSchema,
  TURN_QUEUE_NAME,
} from '@multi-harness/protocol/execution';
import { Worker as BullWorker, type Job, UnrecoverableError } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { PiTurnHost } from './contract.js';
import { executeTurn } from './execution/execute-turn.js';

export interface Worker {
  finished: Promise<void>;
  close(): Promise<void>;
}

export interface WorkerOptions {
  database: Database;
  prefix: string;
  connection: Redis;
  host: PiTurnHost;
  maxRunMs: number;
  logger: Logger;
}

/** Borrows its dependencies; closing stops intake and joins every owned execution. */
export function startWorker(options: WorkerOptions): Worker {
  const { database, prefix, connection, host, maxRunMs, logger } = options;
  const shutdown = new AbortController();
  const worker = new BullWorker<ExecuteTurnJob>(
    TURN_QUEUE_NAME,
    async (job, _token, nativeSignal) => {
      // BullMQ 6 detects AbortSignal support from these three explicit parameters.
      const signal =
        nativeSignal === undefined
          ? shutdown.signal
          : AbortSignal.any([shutdown.signal, nativeSignal]);
      await processTurnJob(database, job, { host, maxRunMs, signal });
    },
    { connection, prefix, autorun: false, concurrency: 1 },
  );
  worker.on('error', () => logger.error({ code: 'turn_worker_error' }, 'Turn worker error'));
  worker.on('lockRenewalFailed', (jobIds) => {
    for (const jobId of jobIds) worker.cancelJob(jobId, 'turn_lock_renewal_failed');
  });

  const finished = worker.run();
  let closing: Promise<void> | undefined;
  return {
    finished,
    close() {
      shutdown.abort();
      closing ??= drainWorker(worker, finished);
      return closing;
    },
  };
}

async function processTurnJob(
  database: Database,
  job: Job<ExecuteTurnJob>,
  options: { host: PiTurnHost; maxRunMs: number; signal: AbortSignal },
): Promise<void> {
  const parsed = ExecuteTurnJobSchema.safeParse(job.data);
  const identity = job.id?.match(
    /^turn-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(0|[1-9][0-9]*)$/,
  );
  if (job.name !== EXECUTE_TURN_JOB_NAME || !parsed.success || identity?.[1] !== parsed.data.turnId)
    throw new UnrecoverableError('invalid_turn_job');

  try {
    await executeTurn(database, { turnId: parsed.data.turnId, ...options });
  } catch {
    // Queue failure records must not contain SQL, provider or native history errors.
    throw new UnrecoverableError('turn_execution_failed');
  }
}

async function drainWorker(
  worker: BullWorker<ExecuteTurnJob>,
  finished: Promise<void>,
): Promise<void> {
  // close() can return after a blocking-disconnect error. run() still owns processor joins.
  const results = await Promise.allSettled([worker.close(), finished]);
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
  }
}
