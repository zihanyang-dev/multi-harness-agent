import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { Redis } from 'ioredis';
import pino from 'pino';
import { type Server, startServer } from '../../apps/server/src/server.js';
import type { Worker } from '../../apps/worker/src/worker.js';
import type { UserMessage } from '../../packages/harness/node_modules/@earendil-works/pi-ai/dist/index.js';
import { createTestDatabase } from '../integration/database.js';
import { createTestQueue } from '../integration/queue.js';
import { startObservationProxy } from './observation-proxy.js';

/** Real HTTP/auth/SQL/queue/native tools; external model/search IO is deterministic and isolated. */
async function main() {
  const root = await mkdtemp(join(tmpdir(), 'mha-browser-'));
  // This dedicated fixture process loads the native graph only after private-home isolation.
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PI_OFFLINE = '1';
  let fixture: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let broker: Awaited<ReturnType<typeof createTestQueue>> | undefined;
  let connection: Redis | undefined;
  let worker: Worker | undefined;
  let server: Server | undefined;
  let observationProxy: Awaited<ReturnType<typeof startObservationProxy>> | undefined;
  const stopped = Promise.withResolvers<void>();
  const stop = () => stopped.resolve();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    const {
      fauxProvider,
      fauxAssistantMessage,
      fauxThinking,
      fauxText,
      fauxToolCall,
      InMemoryCredentialStore,
      InMemoryModelsStore,
    } = await import('../../packages/harness/node_modules/@earendil-works/pi-ai/dist/index.js');
    const { ModelRuntime } = await import(
      '../../packages/harness/node_modules/@earendil-works/pi-coding-agent/dist/index.js'
    );
    const { createPiTurnHost } = await import('../../apps/worker/src/harness/pi/host.js');
    const { startWorker } = await import('../../apps/worker/src/worker.js');
    fixture = await createTestDatabase();
    broker = await createTestQueue();
    connection = broker.connection.duplicate({
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
    });
    connection.on('error', () => {});
    await connection.connect();
    const databaseURL = new URL(process.env.TEST_DATABASE_URL ?? '');
    const schema = (await fixture.pool.query('select current_schema() as schema')).rows[0].schema;
    databaseURL.searchParams.set('options', `-c search_path=${schema}`);
    const faux = fauxProvider({ tokensPerSecond: 120, tokenSize: { min: 1, max: 1 } });
    // Read the actual native transcript; no public-message history reconstruction.
    faux.setResponses(
      Array.from({ length: 100 }, () => (context) => {
        const messages = context.messages.filter((message) => message.role === 'user');
        const text = userText(messages.at(-1));
        if (text.startsWith('WEB_SEARCH')) {
          const result = context.messages.at(-1);
          if (result?.role === 'toolResult')
            return fauxAssistantMessage(
              result.isError
                ? 'The search did not complete.'
                : '## Search result\n\nRead [React state structure](https://react.dev/learn/choosing-the-state-structure). The native search tool returned this source.',
            );
          return fauxAssistantMessage(
            fauxToolCall('web_search', { query: 'React official state structure' }),
            { stopReason: 'toolUse' },
          );
        }
        if (text.startsWith('SLOW_CANCEL'))
          return fauxAssistantMessage('Working carefully. '.repeat(2000));
        if (text.startsWith('STREAM_TEXT'))
          return fauxAssistantMessage(
            `Streaming begins now. ${'A genuine native delta. '.repeat(160)}Streaming finished.`,
          );
        if (text.startsWith('STREAM_REASONING'))
          return fauxAssistantMessage([
            fauxThinking(
              'Private fixture reasoning that must not enter public transport. '.repeat(20),
            ),
            fauxText('Reasoning completed. This is the public answer.'),
          ]);
        if (text.startsWith('MARKDOWN_SAFETY'))
          return fauxAssistantMessage(
            '# Safe result\n\n<script>window.__injected = true</script>\n\n[Unsafe link](javascript:alert(1))\n\n![Remote image](https://example.invalid/tracker.png)',
          );
        const history = messages.length > 1 ? `Earlier request: ${userText(messages[0])}\n\n` : '';
        return fauxAssistantMessage(
          `## Result\n\nI have read: ${text}\n\n${history}- A clear next step\n- A result to iterate on`,
        );
      }),
    );
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const model = faux.getModel();
    const binding = {
      harness: 'pi',
      sdkVersion: '1.1.0',
      policy: 'web-search-v1',
      provider: model.provider,
      model: model.id,
      storageId: 'browser-fixture',
    } as const;
    const logger = pino({ enabled: false });
    const host = createPiTurnHost({
      binding,
      stateRoot: join(root, 'state'),
      modelRuntime,
      webSearch: {
        apiKey: 'browser-fixture-search-only',
        fetch: async (url, init) => {
          if (url !== 'https://api.tavily.com/search')
            throw new Error('Unexpected search endpoint');
          await delay(2500, undefined, init?.signal ? { signal: init.signal } : {});
          return new Response(
            JSON.stringify({
              results: [
                {
                  title: 'Choosing the State Structure',
                  url: 'https://react.dev/learn/choosing-the-state-structure',
                  content: 'Keep state minimal and avoid redundant or contradictory values.',
                },
              ],
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        },
      },
    });
    worker = startWorker({
      database: fixture.database,
      prefix: broker.prefix,
      connection,
      host,
      maxRunMs: 20000,
      logger,
    });
    server = await startServer(
      {
        hostname: '127.0.0.1',
        port: 0,
        backend: {
          databaseURL: databaseURL.href,
          redisURL: process.env.TEST_REDIS_URL ?? '',
          prefix: broker.prefix,
          baseURL: 'http://127.0.0.1:5174',
          secret: randomUUID() + randomUUID(),
          allowSignUp: true,
          binding,
        },
      },
      logger,
    );
    observationProxy = await startObservationProxy({ port: 3001, targetPort: server.port });
    await stopped.promise;
  } finally {
    const joined = await Promise.allSettled([
      server?.close(),
      worker?.close(),
      observationProxy?.close(),
    ]);
    const closed = await Promise.allSettled([fixture?.dispose(), broker?.dispose()]);
    connection?.disconnect();
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    await rm(root, { recursive: true, force: true });
    if ([...joined, ...closed].some((result) => result.status === 'rejected')) {
      console.error('Browser fixture shutdown failed');
      process.exitCode = 1;
    }
  }
}

function userText(message: UserMessage | undefined): string {
  if (message === undefined) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

main().catch(() => {
  console.error('Browser fixture failed');
  process.exitCode = 1;
});
