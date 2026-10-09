import { pino } from 'pino';

const logger = pino({ name: 'worker', level: process.env.LOG_LEVEL ?? 'info' });

logger.warn(
  'Worker scaffold only: no executor registered. Exiting without connecting to Redis or consuming jobs.',
);
