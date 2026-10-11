import { once } from 'node:events';
import { createServer, request, type ServerResponse } from 'node:http';

/** Loopback-only fault injection: forwards real API bytes and can sever one authorized observer. */
export async function startObservationProxy(options: { port: number; targetPort: number }) {
  const streams = new Map<string, Set<ServerResponse>>();
  const blockedDetails = new Set<string>();
  const server = createServer(async (incoming, response) => {
    const disconnect = incoming.url?.match(/^\/__test\/disconnect\/([0-9a-f-]{36})$/);
    if (disconnect && incoming.method === 'POST') {
      if (incoming.headers['x-fixture-control'] !== 'disconnect') {
        response.writeHead(403).end();
        return;
      }
      // Even a test-only observer command must not cross an account boundary.
      const authorized = await fetch(
        `http://127.0.0.1:${options.targetPort}/turns/${disconnect[1]}`,
        {
          headers: incoming.headers.cookie ? { cookie: incoming.headers.cookie } : {},
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        },
      ).catch(() => undefined);
      await authorized?.body?.cancel();
      if (authorized?.status !== 200) {
        response.writeHead(authorized?.status ?? 503).end();
        return;
      }
      blockedDetails.add(disconnect[1] ?? '');
      const observers = streams.get(disconnect[1] ?? '') ?? new Set<ServerResponse>();
      const disconnected = observers.size;
      for (const stream of observers) stream.destroy();
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ disconnected }));
      return;
    }
    const detailId = incoming.url?.match(/^\/turns\/([0-9a-f-]{36})$/)?.[1];
    if (
      incoming.method === 'GET' &&
      detailId &&
      blockedDetails.has(detailId) &&
      incoming.headers['x-fixture-inspect'] !== 'sql'
    ) {
      response
        .writeHead(503, { 'Content-Type': 'application/json' })
        .end('{"error":{"code":"observation_fault"}}');
      return;
    }
    const upstream = request(
      {
        hostname: '127.0.0.1',
        port: options.targetPort,
        path: incoming.url,
        method: incoming.method,
        headers: { ...incoming.headers, host: `127.0.0.1:${options.targetPort}` },
      },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    const turnId = incoming.url?.match(/^\/turns\/([0-9a-f-]{36})\/events$/)?.[1];
    if (turnId) {
      response.setHeader('X-Fixture-Replay-Cursor', incoming.headers['last-event-id'] ?? '');
      const observers = streams.get(turnId) ?? new Set<ServerResponse>();
      observers.add(response);
      streams.set(turnId, observers);
      response.once('close', () => {
        observers.delete(response);
        if (observers.size === 0) streams.delete(turnId);
      });
    }
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502).end();
      else response.destroy();
    });
    incoming.once('aborted', () => upstream.destroy());
    response.once('close', () => {
      // Completed requests may already have returned their socket to the HTTP agent.
      // Only an aborted observer should destroy an in-flight upstream request.
      if (!response.writableFinished) upstream.destroy();
    });
    incoming.pipe(upstream);
  });
  server.listen(options.port, '127.0.0.1');
  await once(server, 'listening');
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const observers of streams.values())
          for (const response of observers) response.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
