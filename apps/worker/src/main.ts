import { closeDatabase, createDatabase } from '@multi-harness/database';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { pino } from 'pino';

import { readWorkerConfig } from './config.js';
import { startWorker, type Worker } from './worker.js';

const logger = pino({ name: 'worker', level: process.env.LOG_LEVEL ?? 'info' });

async function main() {
  const config = readWorkerConfig(process.env);
  if (config === undefined) {
    logger.warn('Agent backend disabled; no infrastructure or native credentials opened');
    return;
  }

  const { InMemoryCredentialStore, InMemoryModelsStore } = await import('@earendil-works/pi-ai');
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const { createPiTurnHost } = await import('./harness/pi/host.js');
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  await modelRuntime.setRuntimeApiKey(config.binding.provider, config.apiKey);
  const host = createPiTurnHost({
    binding: config.binding,
    stateRoot: config.stateRoot,
    modelRuntime,
  });
  const pool = new Pool({
    connectionString: config.databaseURL,
    max: 8,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 6000,
  });
  const database = createDatabase(pool);
  const connection = new Redis(config.redisURL, { maxRetriesPerRequest: null });
  pool.on('error', () => logger.error('Database connection failed'));
  connection.on('error', () => logger.error('Queue worker connection failed'));

  let worker: Worker | undefined;
  const onSignal = () => {
    void worker?.close().catch(() => {
      logger.error('Worker shutdown failed');
      process.exitCode = 1;
    });
  };
  try {
    worker = startWorker({
      database,
      connection,
      host,
      prefix: config.prefix,
      maxRunMs: config.maxRunMs,
      logger,
    });
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    logger.info('Agent worker started');
    await worker.finished;
  } finally {
    // Join native ownership before closing the consumer and its database.
    try {
      await worker?.close();
    } finally {
      try {
        await closeDatabase(database, pool);
      } finally {
        connection.disconnect();
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      }
    }
  }
}

main().catch(() => {
  logger.fatal('Worker startup or execution failed');
  process.exitCode = 1;
});
