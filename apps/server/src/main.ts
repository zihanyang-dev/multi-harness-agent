import { serve } from '@hono/node-server';
import { pino } from 'pino';
import { createApp } from './app.js';

const logger = pino({ name: 'server', level: process.env.LOG_LEVEL ?? 'info' });
const app = createApp();
const server = serve(
  {
    fetch: app.fetch,
    hostname: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 3000),
  },
  (address) => logger.info({ port: address.port }, 'HTTP server listening'),
);

function shutdown() {
  server.close((error) => {
    if (error) {
      logger.error({ err: error }, 'HTTP server shutdown failed');
      process.exitCode = 1;
    }
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
