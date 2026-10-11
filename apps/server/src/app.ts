import type { HealthResponse } from '@multi-harness/protocol/http';
import { Hono } from 'hono';
import { type ConversationApiOptions, createConversationApi } from './conversation/http.js';

export type AppOptions = ConversationApiOptions & {
  handleAuth: (request: Request) => Promise<Response>;
};

export function createApp(options?: AppOptions): Hono {
  const app = new Hono();

  app.get('/healthz', (context) => context.json({ status: 'ok' } satisfies HealthResponse));

  if (options !== undefined) {
    app.onError((_error, context) => context.json({ code: 'internal_error' }, 500));
    app.on(['GET', 'POST'], '/auth/*', (context) => options.handleAuth(context.req.raw));
    app.route('/', createConversationApi(options));
  }

  return app;
}
