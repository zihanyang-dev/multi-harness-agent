import type { HttpBindings } from '@hono/node-server';
import { zValidator } from '@hono/zod-validator';
import type { Database } from '@multi-harness/database';
import { type PiBinding, PiBindingSchema } from '@multi-harness/protocol/execution';
import { SubmitTurnSchema } from '@multi-harness/protocol/http';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { requestCancellation } from '../db/cancellations.js';
import { getTurn, listTurns } from '../db/conversation-history.js';
import { acceptTurn } from '../db/submissions.js';
import { createThread, getThread, listThreads } from '../db/threads.js';
import {
  type ActivityStreamOptions,
  streamTurnActivity,
  validActivityCursor,
} from './activity-stream.js';

export interface ConversationApiOptions {
  database: Database;
  activity?: ActivityStreamOptions;
  binding: PiBinding;
  trustedOrigin: string;
  getOwnerId: (request: Request) => Promise<string | undefined>;
}

const threadParams = zValidator('param', z.object({ threadId: z.uuid() }), (result, context) => {
  if (!result.success) return context.json({ code: 'invalid_request' }, 400);
});
const turnParams = zValidator('param', z.object({ turnId: z.uuid() }), (result, context) => {
  if (!result.success) return context.json({ code: 'invalid_request' }, 400);
});
const historyQuery = zValidator(
  'query',
  z.object({ after: z.uuid().optional() }),
  (result, context) => {
    if (!result.success) return context.json({ code: 'invalid_request' }, 400);
  },
);

/** Trusted authentication supplies the owner; public bodies never select an execution binding. */
export function createConversationApi(
  options: ConversationApiOptions,
): Hono<{ Bindings: HttpBindings; Variables: { ownerId: string } }> {
  const { database, getOwnerId, trustedOrigin } = options;
  const binding = PiBindingSchema.parse(options.binding);
  const api = new Hono<{ Bindings: HttpBindings; Variables: { ownerId: string } }>();

  api.onError((_error, context) => context.json({ code: 'internal_error' }, 500));
  api.use('*', async (context, next) => {
    const ownerId = await getOwnerId(context.req.raw);
    if (ownerId === undefined) return context.json({ code: 'unauthorized' }, 401);
    // Native auth protects its own routes, not separate cookie-authenticated product mutations.
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(context.req.method) &&
      context.req.header('origin') !== trustedOrigin
    )
      return context.json({ code: 'forbidden_origin' }, 403);
    context.set('ownerId', ownerId);
    await next();
  });
  api.use(
    '*',
    bodyLimit({
      maxSize: 128 * 1024,
      onError: (context) => context.json({ code: 'body_too_large' }, 413),
    }),
  );

  api.post('/threads', async (context) => {
    const thread = await createThread(database, { ownerId: context.get('ownerId'), binding });
    return context.json(thread, 201);
  });
  api.get('/threads', historyQuery, async (context) => {
    const { after } = context.req.valid('query');
    const page = await listThreads(database, {
      ownerId: context.get('ownerId'),
      ...(after === undefined ? {} : { after }),
    });
    return page === undefined ? context.json({ code: 'not_found' }, 404) : context.json(page);
  });
  api.get('/threads/:threadId', threadParams, async (context) => {
    const thread = await getThread(database, {
      ownerId: context.get('ownerId'),
      ...context.req.valid('param'),
    });
    return thread === undefined ? context.json({ code: 'not_found' }, 404) : context.json(thread);
  });
  api.post('/threads/:threadId/turns', threadParams, async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ code: 'invalid_request' }, 400);
    }
    const submission = SubmitTurnSchema.safeParse(body);
    if (!submission.success) return context.json({ code: 'invalid_request' }, 400);
    const result = await acceptTurn(database, {
      ownerId: context.get('ownerId'),
      ...context.req.valid('param'),
      ...submission.data,
    });
    if (result.kind === 'not_found') return context.json({ code: 'not_found' }, 404);
    if (result.kind === 'conflict') return context.json({ code: result.reason }, 409);
    return context.json(result.turn, result.replayed ? 200 : 202);
  });
  api.get('/threads/:threadId/turns', threadParams, historyQuery, async (context) => {
    const { after } = context.req.valid('query');
    const page = await listTurns(database, {
      ownerId: context.get('ownerId'),
      ...context.req.valid('param'),
      ...(after === undefined ? {} : { after }),
    });
    return page === undefined ? context.json({ code: 'not_found' }, 404) : context.json(page);
  });
  api.get('/turns/:turnId', turnParams, async (context) => {
    const turn = await getTurn(database, {
      ownerId: context.get('ownerId'),
      ...context.req.valid('param'),
    });
    return turn === undefined ? context.json({ code: 'not_found' }, 404) : context.json(turn);
  });
  api.get('/turns/:turnId/events', turnParams, async (context) => {
    const cursor = context.req.header('Last-Event-ID') ?? '0-0';
    if (!validActivityCursor(cursor)) return context.json({ code: 'invalid_request' }, 400);
    const turn = await getTurn(database, {
      ownerId: context.get('ownerId'),
      ...context.req.valid('param'),
    });
    if (turn === undefined) return context.json({ code: 'not_found' }, 404);
    if (options.activity === undefined) return context.json({ code: 'activity_unavailable' }, 503);
    const activity = options.activity;
    return streamSSE(context, (stream) =>
      streamTurnActivity(stream, {
        ...activity,
        database,
        getOwnerId,
        request: context.req.raw,
        ownerId: context.get('ownerId'),
        turn,
        cursor,
        // Healthy readers receive graceful EOF; only stalled native writes need socket release.
        // App.request has no Node bindings, unlike the production HTTP adapter.
        disconnect: () => {
          const outgoing = context.env?.outgoing;
          if (outgoing?.writableNeedDrain) outgoing.destroy();
        },
      }),
    );
  });
  api.post('/turns/:turnId/cancel', turnParams, async (context) => {
    const turn = await requestCancellation(database, {
      ownerId: context.get('ownerId'),
      ...context.req.valid('param'),
    });
    return turn === undefined ? context.json({ code: 'not_found' }, 404) : context.json(turn);
  });

  return api;
}
