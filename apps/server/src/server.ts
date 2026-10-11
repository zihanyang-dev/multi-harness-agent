import { once } from 'node:events';
import { type ServerType, serve } from '@hono/node-server';
import { closeDatabase, createDatabase } from '@multi-harness/database';
import type { ExecuteTurnJob } from '@multi-harness/protocol/execution';
import type { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import type { Logger } from 'pino';

import { createApp } from './app.js';
import type { ServerConfig } from './config.js';
import { createCommandQueue, publishCommands } from './conversation/command-publication.js';
import { createAuth } from './identity/authentication.js';

export interface Server {
  port: number;
  finished: Promise<void>;
  close(): Promise<void>;
}

/** Owns HTTP admission and product publication, including all process-local resources. */
export async function startServer(config: ServerConfig, logger: Logger): Promise<Server> {
  const { hostname, port, backend } = config;
  const pool =
    backend === undefined
      ? undefined
      : new Pool({
          connectionString: backend.databaseURL,
          max: 8,
          connectionTimeoutMillis: 5000,
          statement_timeout: 5000,
          query_timeout: 6000,
        });
  const database = pool === undefined ? undefined : createDatabase(pool);
  const connection =
    backend === undefined
      ? undefined
      : new Redis(backend.redisURL, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          commandTimeout: 5000,
        });
  const shutdown = new AbortController();
  let queue: Queue<ExecuteTurnJob> | undefined;
  let http: ServerType | undefined;
  let publication: Promise<void> | undefined;
  let closing: Promise<void> | undefined;

  const close = () =>
    (closing ??= (async () => {
      shutdown.abort();
      // Stop admission and join publication before disconnecting either durable transport.
      const joined = await Promise.allSettled([closeHttp(http), publication]);
      const closed = await Promise.allSettled([
        queue?.close(),
        database !== undefined && pool !== undefined ? closeDatabase(database, pool) : undefined,
      ]);
      connection?.disconnect();
      if ([...joined, ...closed].some((result) => result.status === 'rejected'))
        throw new Error('server_shutdown_failed');
    })());

  try {
    let app = createApp();
    if (
      backend !== undefined &&
      pool !== undefined &&
      database !== undefined &&
      connection !== undefined
    ) {
      pool.on('error', () => logger.error('Database connection failed'));
      connection.on('error', () => logger.error('Queue publisher connection failed'));
      const auth = createAuth({
        pool,
        baseURL: backend.baseURL,
        secret: backend.secret,
        allowSignUp: backend.allowSignUp,
      });
      app = createApp({
        database,
        binding: backend.binding,
        trustedOrigin: new URL(backend.baseURL).origin,
        handleAuth: (request) => auth.handler(request),
        getOwnerId: async (request) =>
          (await auth.api.getSession({ headers: request.headers }))?.user.id,
      });
      await connection.connect();
      queue = createCommandQueue(connection, backend.prefix);
      queue.on('error', () => logger.error('Command queue failed'));
      await queue.waitUntilReady();
    }

    http = serve({ fetch: app.fetch, hostname, port });
    const finished = once(http, 'close').then(() => undefined);
    // Observe startup and later HTTP failures without leaking transport errors to diagnostics.
    void finished.catch(() => close().catch(() => logger.error('Server shutdown failed')));
    await once(http, 'listening');
    const address = http.address();
    if (address === null || typeof address === 'string') throw new Error('invalid_http_address');
    if (database !== undefined && queue !== undefined) {
      publication = publishCommands(database, queue, shutdown.signal, logger);
      void publication.catch(() => {
        logger.error('Command publisher stopped unexpectedly');
        return close().catch(() => logger.error('Server shutdown failed'));
      });
    }
    logger.info({ port: address.port, productApi: backend !== undefined }, 'HTTP server listening');
    return { port: address.port, finished, close };
  } catch {
    await close();
    throw new Error('server_initialization_failed');
  }
}

async function closeHttp(server: ServerType | undefined): Promise<void> {
  if (server === undefined || !server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
