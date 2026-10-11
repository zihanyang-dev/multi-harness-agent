import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';

import { createCommandQueue } from '../../apps/server/src/conversation/command-publication.js';

/** Owns only one random test queue; never flushes the Redis database or reads local credentials. */
export async function createTestQueue() {
  const url = process.env.TEST_REDIS_URL;
  if (url === undefined) throw new Error('TEST_REDIS_URL is required for integration checks');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
    throw new Error('Integration checks require a loopback Redis server');
  const prefix = `test-${randomUUID()}`;
  const connection = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  await connection.connect();
  const queue = createCommandQueue(connection, prefix);
  await queue.waitUntilReady();
  return {
    queue,
    prefix,
    connection,
    async dispose() {
      try {
        await queue.obliterate();
      } finally {
        await queue.close();
        connection.disconnect();
      }
    },
  };
}
