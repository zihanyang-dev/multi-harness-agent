import type { HealthResponse } from '@multi-harness/protocol';
import { Hono } from 'hono';

export function createApp() {
  const app = new Hono();

  app.get('/healthz', (context) => context.json({ status: 'ok' } satisfies HealthResponse));

  return app;
}
