import { pino } from 'pino';
import { expect, it } from 'vitest';

import { startServer } from './server.js';

it('owns a health-only HTTP lifetime without product infrastructure', async () => {
  const server = await startServer(
    { hostname: '127.0.0.1', port: 0, backend: undefined },
    pino({ level: 'silent' }),
  );
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  } finally {
    const closing = server.close();
    expect(server.close()).toBe(closing);
    await closing;
    await server.finished;
  }
});
