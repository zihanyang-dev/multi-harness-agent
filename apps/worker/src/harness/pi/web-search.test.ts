import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { createWebSearchTool } from './web-search.js';

const execute = (fetch: typeof globalThis.fetch, signal?: AbortSignal, query = 'current news') =>
  createWebSearchTool({ apiKey: 'private-key', fetch }).execute(
    'call',
    { query },
    signal,
    undefined,
    undefined as never,
  );
const source = { title: 'News', url: 'https://example.com/news', content: 'A public snippet' };

it('uses the fixed official API, keeps the key private, and returns owned JSON text', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ results: [source], answer: 'ignored' }),
  );
  const result = await execute(fetch);
  expect(fetch).toHaveBeenCalledTimes(1);
  const call = fetch.mock.calls[0];
  if (!call) throw new Error('Expected provider request');
  const [url, init] = call;
  expect(url).toBe('https://api.tavily.com/search');
  expect(init).toMatchObject({
    method: 'POST',
    redirect: 'error',
    headers: { Authorization: 'Bearer private-key', 'Content-Type': 'application/json' },
  });
  expect(JSON.parse(init?.body as string)).toEqual({
    query: 'current news',
    max_results: 5,
    search_depth: 'basic',
    include_answer: false,
    include_raw_content: false,
  });
  expect(result.content).toEqual([
    {
      type: 'text',
      text: JSON.stringify({
        query: 'current news',
        results: [{ title: 'News', url: source.url, snippet: source.content }],
      }),
    },
  ]);
  expect(JSON.stringify(result)).not.toContain('private-key');
});

it('bounds sources and text and rejects non-public URLs without fetching sources', async () => {
  const invalid = [
    'file:///etc/passwd',
    'http://localhost/x',
    'http://127.0.0.1',
    'http://10.0.0.1',
    'https://[::1]',
    'https://user:pass@example.com',
    'http://metadata.google.internal',
    'javascript:alert(1)',
    'http://2130706433',
  ];
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({
      results: [
        ...invalid.map((url) => ({ ...source, url })),
        ...Array.from({ length: 6 }, () => ({
          ...source,
          title: 't'.repeat(1000),
          content: '\u0000'.repeat(1000),
        })),
      ],
    }),
  );
  const result = await execute(fetch);
  const text = result.content[0];
  if (!text) throw new Error('Expected tool content');
  expect(text.type).toBe('text');
  if (text.type !== 'text') throw new Error('Expected text');
  expect(text.text.length).toBeLessThanOrEqual(8192);
  const decoded = JSON.parse(text.text);
  expect(decoded.results.length).toBeGreaterThan(0);
  expect(decoded.results.length).toBeLessThanOrEqual(5);
  for (const item of decoded.results) {
    expect(item.url).toBe(source.url);
    expect(item.title.length).toBeLessThanOrEqual(150);
    expect(item.snippet.length).toBeLessThanOrEqual(700);
  }
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each(['status', 'json', 'schema', 'overflow', 'network'])(
  'redacts %s failures without retry or native error cause',
  async (failure) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      if (failure === 'network') throw new Error('private-key provider details');
      if (failure === 'status') return new Response('private-key', { status: 429 });
      if (failure === 'json') return new Response('private-key');
      if (failure === 'schema') return Response.json({ private: 'private-key' });
      return new Response('x'.repeat(65537));
    });
    const error = await execute(fetch).catch((error) => error);
    expect(error.message).toBe('Web search unavailable');
    expect(error.cause).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it('combines native cancellation with a deadline and refuses invalid input before IO', async () => {
  const controller = new AbortController();
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    expect(init?.signal).not.toBe(controller.signal);
    controller.abort(new Error('private-key'));
    init?.signal?.throwIfAborted();
    return Response.json({ results: [] });
  });
  await expect(execute(fetch, controller.signal)).rejects.toThrow('Web search unavailable');
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockClear();
  await expect(execute(fetch, undefined, ' ')).rejects.toThrow('Web search unavailable');
  expect(fetch).not.toHaveBeenCalled();
});

it('cancels a stalled response body when the native turn aborts', async () => {
  const controller = new AbortController();
  const cancel = vi.fn();
  const fetch: typeof globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start() {
          setTimeout(() => controller.abort(), 10);
        },
        cancel,
      }),
    );
  await expect(execute(fetch, controller.signal)).rejects.toThrow('Web search unavailable');
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('enforces the eight-second deadline even while reading a stalled body', async () => {
  const cancel = vi.fn();
  const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream({ cancel }));
  await expect(execute(fetch)).rejects.toThrow('Web search unavailable');
  expect(cancel).toHaveBeenCalledTimes(1);
}, 10000);

it('does not publish even a provider snippet that echoes the private key', async () => {
  const fetch: typeof globalThis.fetch = async () =>
    Response.json({ results: [{ ...source, content: 'private-key' }] });
  await expect(execute(fetch)).rejects.toThrow('Web search unavailable');
});

// Keep the SDK graph out of the ordinary Vitest worker, matching the existing host launcher.
it('runs a real native search tool loop and fail-closed profile checks in an isolated process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mha-search-offline-'));
  const fixture = join(root, 'native.test.mts');
  const config = join(root, 'vitest.config.mts');
  const vitest = join(
    dirname(fileURLToPath(import.meta.resolve('vitest/package.json'))),
    'vitest.mjs',
  );
  try {
    await writeFile(
      fixture,
      `
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, it } from ${JSON.stringify(import.meta.resolve('vitest'))};
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore } from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-ai'))};
import { ModelRuntime } from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-coding-agent'))};
import { createPiTurnHost } from ${JSON.stringify(new URL('./host.ts', import.meta.url).href)};
it('uses the SDK tool loop, exposes only owned tool text, and keeps text profiles immutable', async () => {
  const faux = fauxProvider({ tokenSize: { min: 1, max: 1 } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = faux.getModel();
  const binding = { harness: 'pi', sdkVersion: '1.1.0', provider: model.provider, model: model.id, policy: 'web-search-v1', storageId: 'test' };
  const base = { binding, modelRuntime, stateRoot: join(process.env.PI_CODING_AGENT_DIR, 'state') };
  expect(() => createPiTurnHost(base)).toThrow(/policy/);
  const webSearch = { apiKey: 'secret-search-key', fetch: async (url, init) => {
    expect(url).toBe('https://api.tavily.com/search');
    expect(init.headers.Authorization).toBe('Bearer secret-search-key');
    return Response.json({ results: [{ title: 'Source', url: 'https://example.com/', content: 'Public snippet' }] });
  } };
  expect(() => createPiTurnHost({ ...base, binding: { ...binding, policy: 'text-v1' }, webSearch })).toThrow(/policy/);
  const host = createPiTurnHost({ ...base, webSearch });
  let observed = false;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('web_search', { query: 'current facts' }, { id: 'search-1' }), { stopReason: 'toolUse' }),
    context => {
      const result = context.messages.find(message => message.role === 'toolResult');
      expect(result.toolName).toBe('web_search');
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ query: 'current facts', results: [{ title: 'Source', url: 'https://example.com/', snippet: 'Public snippet' }] }) }]);
      expect(JSON.stringify(context)).not.toContain('secret-search-key');
      observed = true;
      return fauxAssistantMessage('Answer with a source');
    },
  ]);
  const session = await host.openSession({ threadId: randomUUID() });
  try {
    const run = await session.run({ content: [{ type: 'text', text: 'Search for current facts' }] });
    const events = [];
    for await (const event of run.events) events.push(event);
    expect((await run.result).status).toBe('completed');
    expect(observed).toBe(true);
    expect(faux.state.callCount).toBe(2);
    expect(events.some(event => event.type === 'TOOL_CALL_START' && event.toolCallName === 'web_search')).toBe(true);
    expect(events.some(event => event.type === 'TOOL_CALL_RESULT' && event.content.includes('Public snippet'))).toBe(true);
    expect(JSON.stringify(events)).not.toContain('secret-search-key');
  } finally { await session.dispose(); }
});
`,
    );
    await writeFile(
      config,
      `export default ${JSON.stringify({ root: process.cwd(), resolve: { conditions: ['development'] }, test: { environment: 'node', include: [fixture] } })};`,
    );
    await promisify(execFile)(process.execPath, [vitest, 'run', '--config', config], {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        XDG_CONFIG_HOME: root,
        PI_CODING_AGENT_DIR: root,
        PI_OFFLINE: '1',
        NO_COLOR: '1',
      },
      timeout: 30000,
    }).catch((error: unknown) => {
      if (error instanceof Error && 'stdout' in error && 'stderr' in error)
        throw new Error(`${error.stdout}\n${error.stderr}`);
      throw error;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 40000);

it('bounds UTF-8 tool output as well as escaped JSON characters', async () => {
  const fetch: typeof globalThis.fetch = async () =>
    Response.json({
      results: Array.from({ length: 5 }, () => ({
        ...source,
        title: '新'.repeat(150),
        content: '聞'.repeat(700),
      })),
    });
  const result = await execute(fetch);
  const content = result.content[0];
  if (content?.type !== 'text') throw new Error('Expected text');
  expect(Buffer.byteLength(content.text, 'utf8')).toBeLessThanOrEqual(8192);
});
