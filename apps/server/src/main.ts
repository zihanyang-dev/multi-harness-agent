import { pino } from 'pino';

import { readServerConfig } from './config.js';
import { startServer } from './server.js';

const logger = pino({ name: 'server', level: process.env.LOG_LEVEL ?? 'info' });

async function main() {
  const server = await startServer(readServerConfig(process.env), logger);
  const onSignal = () => {
    void server.close().catch(() => {
      logger.error('Server shutdown failed');
      process.exitCode = 1;
    });
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    await server.finished;
  } finally {
    try {
      await server.close();
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
  }
}

main().catch(() => {
  logger.fatal('Server startup or execution failed');
  process.exitCode = 1;
});
