import { execFileSync } from 'node:child_process';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { EventType } from '@ag-ui/core';
import { MemorySession, OpenAIConversationsSession } from '@openai/agents';
import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';

import { createOpenAIClientFixture } from '../../tests/fixtures/openai-client.js';
import { createOpenAIHarness, type OpenAISessions } from '../index.js';

describe('OpenAI native session', () => {
  it('uses host-supplied SDK history across turns without calling Conversations', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueue('First answer', 'Second answer');
    // SDK memory is deliberately test-only; this verifies wiring, not durable recovery.
    const nativeSession = new MemorySession({ sessionId: 'host_session' });
    const openedIds: (string | undefined)[] = [];
    const provider = createOpenAIHarness({
      client: fixture.client,
      model: 'gpt-4.1',
      sessions: {
        resumable: false,
        open: async (id) => {
          openedIds.push(id);
          return nativeSession;
        },
      },
    });
    const session = await provider.openSession({ cwd: process.cwd() });
    try {
      await (await session.run({ content: [{ type: 'text', text: 'First question' }] })).result;
      const second = await session.run({ content: [{ type: 'text', text: 'Second question' }] });
      const events = [];
      for await (const event of second.events) events.push(event);
      expect((await second.result).messages).toEqual([
        { id: 'msg_fixture_2', role: 'assistant', content: 'Second answer' },
      ]);
      expect(events[0]).toMatchObject({
        type: EventType.RUN_STARTED,
        threadId: 'host_session',
      });
      expect(fixture.requests.map((request) => request.path)).toEqual(['/responses', '/responses']);
      expect(fixture.requests[1]?.body?.input).toEqual([
        { role: 'user', content: [{ type: 'input_text', text: 'First question' }] },
        expect.objectContaining({ role: 'assistant' }),
        { role: 'user', content: [{ type: 'input_text', text: 'Second question' }] },
      ]);
      expect(openedIds).toEqual([undefined]);
    } finally {
      await session.dispose();
    }
    // Disposing a wrapper must not clear the borrowed native history.
    expect(await nativeSession.getItems()).toHaveLength(4);
  });

  it('keeps model transport separate from the explicitly selected Conversations store', async () => {
    const model = createOpenAIClientFixture();
    const history = createOpenAIClientFixture();
    model.enqueue('First answer', 'Second answer');
    const provider = createOpenAIHarness({
      client: model.client,
      model: 'gpt-4.1',
      sessions: conversationSessions(history.client),
    });
    const first = await provider.openSession({ cwd: process.cwd() });
    try {
      await (await first.run({ content: [{ type: 'text', text: 'First question' }] })).result;
    } finally {
      await first.dispose();
    }
    const reopened = await provider.openSession({
      cwd: process.cwd(),
      nativeSessionId: first.nativeSessionId,
    });
    try {
      await (await reopened.run({ content: [{ type: 'text', text: 'Second question' }] })).result;
      expect(model.requests.map((request) => request.path)).toEqual(['/responses', '/responses']);
      expect(model.requests[1]?.body?.input).toEqual([
        expect.objectContaining({
          role: 'user',
          content: [{ type: 'input_text', text: 'First question' }],
        }),
        expect.objectContaining({ role: 'assistant' }),
        expect.objectContaining({
          role: 'user',
          content: [{ type: 'input_text', text: 'Second question' }],
        }),
      ]);
      expect(history.requests.some((request) => request.path === '/responses')).toBe(false);
    } finally {
      await reopened.dispose();
    }
  });

  it('rejects resume admission before opening a non-resumable source', async () => {
    const fixture = createOpenAIClientFixture();
    let opened = false;
    const provider = createOpenAIHarness({
      client: fixture.client,
      model: 'gpt-4.1',
      sessions: {
        resumable: false,
        open: async () => {
          opened = true;
          return new MemorySession({ sessionId: 'requested_session' });
        },
      },
    });
    await expect(
      provider.openSession({ cwd: process.cwd(), nativeSessionId: 'requested_session' }),
    ).rejects.toThrow(/resume/);
    expect(provider.capabilities.resume).toBe(false);
    expect(opened).toBe(false);
    expect(fixture.requests).toEqual([]);
  });

  it.each([
    { requested: undefined, returned: '' },
    { requested: undefined, returned: '  ' },
    { requested: 'requested_session', returned: 'replacement_session' },
  ])('rejects an invalid or replaced native identity (%j)', async ({ requested, returned }) => {
    const fixture = createOpenAIClientFixture();
    const provider = createOpenAIHarness({
      client: fixture.client,
      model: 'gpt-4.1',
      sessions: {
        resumable: true,
        open: async () => new MemorySession({ sessionId: returned }),
      },
    });
    await expect(
      provider.openSession({
        cwd: process.cwd(),
        ...(requested !== undefined ? { nativeSessionId: requested } : {}),
      }),
    ).rejects.toThrow(/session ID/);
    expect(fixture.requests).toEqual([]);
  });

  it('preserves a source opening failure without falling back to another backend', async () => {
    const fixture = createOpenAIClientFixture();
    const failure = new Error('Host storage unavailable');
    const provider = createOpenAIHarness({
      client: fixture.client,
      model: 'gpt-4.1',
      sessions: {
        resumable: true,
        open: async () => {
          throw failure;
        },
      },
    });
    await expect(provider.openSession({ cwd: process.cwd() })).rejects.toBe(failure);
    expect(fixture.requests).toEqual([]);
  });

  it('reopens host-supplied native items in a new provider without Conversations', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueue('First answer', 'Second answer');
    const original = new MemorySession({ sessionId: 'host_snapshot' });
    const openedIds: (string | undefined)[] = [];
    // This source reopens process-local SDK snapshots, not durable production storage.
    const configuration = {
      client: fixture.client,
      model: 'gpt-4.1',
      sessions: {
        resumable: true,
        open: async (id?: string) => {
          openedIds.push(id);
          if (id === undefined) return original;
          return new MemorySession({ sessionId: id, initialItems: await original.getItems() });
        },
      },
    };
    const first = await createOpenAIHarness(configuration).openSession({ cwd: process.cwd() });
    try {
      await (await first.run({ content: [{ type: 'text', text: 'First question' }] })).result;
    } finally {
      await first.dispose();
    }
    const reopened = await createOpenAIHarness(configuration).openSession({
      cwd: process.cwd(),
      nativeSessionId: first.nativeSessionId,
    });
    try {
      await (await reopened.run({ content: [{ type: 'text', text: 'Second question' }] })).result;
      expect(reopened.nativeSessionId).toBe('host_snapshot');
      expect(openedIds).toEqual([undefined, 'host_snapshot']);
      expect(fixture.requests.map((request) => request.path)).toEqual(['/responses', '/responses']);
      expect(fixture.requests[1]?.body?.input).toEqual([
        { role: 'user', content: [{ type: 'input_text', text: 'First question' }] },
        expect.objectContaining({ role: 'assistant' }),
        { role: 'user', content: [{ type: 'input_text', text: 'Second question' }] },
      ]);
    } finally {
      await reopened.dispose();
    }
  });

  it('preserves a native identity lookup failure before returning a wrapper', async () => {
    const fixture = createOpenAIClientFixture();
    const nativeSession = new MemorySession();
    const failure = new Error('Host identity lookup failed');
    // Fail only the host's async identity lookup, retaining the real SDK history methods.
    nativeSession.getSessionId = async () => {
      throw failure;
    };
    const provider = createOpenAIHarness({
      client: fixture.client,
      model: 'gpt-4.1',
      sessions: { resumable: true, open: async () => nativeSession },
    });
    await expect(provider.openSession({ cwd: process.cwd() })).rejects.toBe(failure);
    expect(fixture.requests).toEqual([]);
  });

  it('runs through the real SDK and exposes the existing text projection', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueue('Hello');
    const provider = createOpenAIHarness({
      client: fixture.client,
      sessions: conversationSessions(fixture.client),
      model: 'gpt-4.1',
    });
    const session = await provider.openSession({ cwd: process.cwd() });

    try {
      const run = await session.run({ content: [{ type: 'text', text: 'Say hello.' }] });
      const events = [];
      for await (const event of run.events) events.push(event);

      expect(await run.result).toEqual({
        status: 'completed',
        messages: [{ id: 'msg_fixture_1', role: 'assistant', content: 'Hello' }],
      });
      expect(events[0]).toMatchObject({
        type: EventType.RUN_STARTED,
        threadId: session.nativeSessionId,
      });
      expect(events.at(-1)).toMatchObject({
        type: EventType.RUN_FINISHED,
        outcome: { type: 'success' },
      });
    } finally {
      await session.dispose();
    }
  });

  it('reopens Conversations history using its native ID rather than public messages', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueue('First answer', 'Second answer');
    const provider = createOpenAIHarness({
      client: fixture.client,
      sessions: conversationSessions(fixture.client),
      model: 'gpt-4.1',
    });
    const original = await provider.openSession({ cwd: process.cwd() });
    await (await original.run({ content: [{ type: 'text', text: 'First question' }] })).result;
    await original.dispose();

    const reopened = await provider.openSession({
      cwd: process.cwd(),
      nativeSessionId: original.nativeSessionId,
    });
    try {
      await (await reopened.run({ content: [{ type: 'text', text: 'Second question' }] })).result;

      expect(reopened.nativeSessionId).toBe(original.nativeSessionId);
      const request = fixture.requests.filter((item) => item.path === '/responses')[1];
      expect(request?.body?.input).toEqual([
        expect.objectContaining({
          role: 'user',
          content: [{ type: 'input_text', text: 'First question' }],
        }),
        expect.objectContaining({ role: 'assistant' }),
        expect.objectContaining({
          role: 'user',
          content: [{ type: 'input_text', text: 'Second question' }],
        }),
      ]);
      expect(fixture.requests.some((item) => item.method === 'DELETE')).toBe(false);
    } finally {
      await reopened.dispose();
    }
  });

  it('settles without an event reader and admits the next turn on the same session', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueue('First answer', 'Second answer');
    const session = await createOpenAIHarness({
      client: fixture.client,
      sessions: conversationSessions(fixture.client),
      model: 'gpt-4.1',
    }).openSession({ cwd: process.cwd() });

    try {
      const first = await session.run({ content: [{ type: 'text', text: 'First question' }] });
      expect((await first.result).status).toBe('completed');
      const second = await session.run({ content: [{ type: 'text', text: 'Second question' }] });
      expect((await second.result).messages).toEqual([
        { id: 'msg_fixture_2', role: 'assistant', content: 'Second answer' },
      ]);
    } finally {
      await session.dispose();
    }
  });

  it('rejects concurrent turns while the native response remains active', async () => {
    const release = Promise.withResolvers<void>();
    const fixture = createOpenAIClientFixture({ pauseAfterText: release.promise });
    fixture.enqueue('Hello');
    const session = await createOpenAIHarness({
      client: fixture.client,
      sessions: conversationSessions(fixture.client),
      model: 'gpt-4.1',
    }).openSession({ cwd: process.cwd() });
    const run = await session.run({ content: [{ type: 'text', text: 'Start' }] });
    const observer = run.events[Symbol.asyncIterator]();
    await observer.next();
    await observer.next();

    try {
      await expect(session.run({ content: [{ type: 'text', text: 'Overlap' }] })).rejects.toThrow(
        /active/,
      );
    } finally {
      release.resolve();
      await observer.return?.();
      await run.result;
      await session.dispose();
    }
  });

  it('keeps the writer until an interrupted native run actually settles', async () => {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fixture = createOpenAIClientFixture({
      beforeRequest: async (request) => {
        if (request.method === 'POST' && request.path.endsWith('/items')) {
          reached.resolve();
          await release.promise;
        }
      },
    });
    fixture.enqueue('Hello');
    const session = await createOpenAIHarness({
      client: fixture.client,
      sessions: conversationSessions(fixture.client),
      model: 'gpt-4.1',
    }).openSession({ cwd: process.cwd() });
    const run = await session.run({ content: [{ type: 'text', text: 'Start' }] });
    const observer = run.events[Symbol.asyncIterator]();
    await observer.next();
    await observer.next();
    await observer.next();

    try {
      await reached.promise;
      await run.interrupt();
      await setImmediate();
      await expect(session.run({ content: [{ type: 'text', text: 'Overlap' }] })).rejects.toThrow(
        /active/,
      );
    } finally {
      release.resolve();
    }
    expect((await run.result).status).toBe('cancelled');
    const remaining = [];
    for await (const event of { [Symbol.asyncIterator]: () => observer }) remaining.push(event);
    expect(remaining.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: 'cancelled' },
    });
    await session.dispose();
  });

  it('waits for native settlement during disposal without deleting remote history', async () => {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fixture = createOpenAIClientFixture({
      beforeRequest: async (request) => {
        if (request.method === 'POST' && request.path.endsWith('/items')) {
          reached.resolve();
          await release.promise;
        }
      },
    });
    fixture.enqueue('Hello');
    const session = await createOpenAIHarness({
      client: fixture.client,
      sessions: conversationSessions(fixture.client),
      model: 'gpt-4.1',
    }).openSession({ cwd: process.cwd() });
    const run = await session.run({ content: [{ type: 'text', text: 'Start' }] });
    const observer = run.events[Symbol.asyncIterator]();
    await observer.next();
    await observer.next();
    await observer.next();
    await reached.promise;
    let disposed = false;
    const disposal = session.dispose();
    const settled = disposal.then(() => {
      disposed = true;
    });

    try {
      expect(session.dispose()).toBe(disposal);
      await setImmediate();
      expect(disposed).toBe(false);
      await expect(
        session.run({ content: [{ type: 'text', text: 'After disposal' }] }),
      ).rejects.toThrow(/disposed/);
    } finally {
      release.resolve();
    }
    await settled;
    expect((await run.result).status).toBe('cancelled');
    await observer.return?.();
    expect(fixture.requests.some((item) => item.method === 'DELETE')).toBe(false);
  });

  it.each(['', '  '])(
    'rejects an empty resume identity without creating new history (%j)',
    async (nativeSessionId) => {
      const fixture = createOpenAIClientFixture();
      const provider = createOpenAIHarness({
        client: fixture.client,
        sessions: conversationSessions(fixture.client),
        model: 'gpt-4.1',
      });
      await expect(provider.openSession({ cwd: process.cwd(), nativeSessionId })).rejects.toThrow(
        /session ID/,
      );
      expect(fixture.requests).toEqual([]);
    },
  );

  it('joins cancellation during native history setup and reports a cancelled result', async () => {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fixture = createOpenAIClientFixture({
      beforeRequest: async (request) => {
        if (request.method === 'GET' && request.path.endsWith('/items')) {
          reached.resolve();
          await release.promise;
        }
      },
    });
    const session = await createOpenAIHarness({
      client: fixture.client,
      sessions: conversationSessions(fixture.client),
      model: 'gpt-4.1',
    }).openSession({ cwd: process.cwd() });
    const pending = session.run({ content: [{ type: 'text', text: 'Start' }] });
    await reached.promise;
    let disposed = false;
    const disposal = session.dispose().then(() => {
      disposed = true;
    });
    try {
      await setImmediate();
      expect(disposed).toBe(false);
      await expect(
        session.run({ content: [{ type: 'text', text: 'After disposal' }] }),
      ).rejects.toThrow(/disposed/);
    } finally {
      release.resolve();
    }
    const run = await pending;
    await expect(run.result).resolves.toMatchObject({ status: 'cancelled' });
    const events = [];
    for await (const event of run.events) events.push(event);
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: 'cancelled' },
    });
    await disposal;
    expect(fixture.requests.some((request) => request.path === '/responses')).toBe(false);
  });

  it('reports cancellation requested before the first model response event', async () => {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fixture = createOpenAIClientFixture({
      beforeRequest: async (request) => {
        if (request.path === '/responses') {
          reached.resolve();
          await release.promise;
        }
      },
    });
    fixture.enqueue('Answer');
    const session = await createOpenAIHarness({
      client: fixture.client,
      sessions: conversationSessions(fixture.client),
      model: 'gpt-4.1',
    }).openSession({ cwd: process.cwd() });
    const run = await session.run({ content: [{ type: 'text', text: 'Start' }] });
    try {
      await reached.promise;
      await run.interrupt();
    } finally {
      release.resolve();
    }
    expect((await run.result).status).toBe('cancelled');
    await session.dispose();
  });

  it('forwards fixed configuration and preserves separate text parts in order', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueue('Answer');
    const session = await createOpenAIHarness({
      client: fixture.client,
      sessions: conversationSessions(fixture.client),
      model: 'configured-model',
      instructions: 'Be concise.',
      modelSettings: { store: false, temperature: 0.2 },
    }).openSession({ cwd: process.cwd() });
    try {
      await (
        await session.run({
          content: [
            { type: 'text', text: 'First' },
            { type: 'text', text: 'Second' },
          ],
        })
      ).result;
      expect(fixture.requests.find((item) => item.path === '/responses')?.body).toMatchObject({
        model: 'configured-model',
        instructions: 'Be concise.',
        store: false,
        temperature: 0.2,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'First' },
              { type: 'input_text', text: 'Second' },
            ],
          },
        ],
      });
    } finally {
      await session.dispose();
    }
  });

  it('rejects an attachment before starting native work and still admits a text turn', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueue('Answer');
    const session = await createOpenAIHarness({
      client: fixture.client,
      sessions: conversationSessions(fixture.client),
      model: 'gpt-4.1',
    }).openSession({ cwd: process.cwd() });
    const requestCount = fixture.requests.length;
    try {
      await expect(
        session.run({
          content: [
            {
              type: 'file',
              source: new URL('https://files.example/document.pdf'),
              mimeType: 'application/pdf',
            },
          ],
        }),
      ).rejects.toThrow(/File input/);
      expect(fixture.requests).toHaveLength(requestCount);
      expect(
        (await (await session.run({ content: [{ type: 'text', text: 'Continue' }] })).result)
          .status,
      ).toBe('completed');
    } finally {
      await session.dispose();
    }
  });

  it('preserves a provider failure while releasing the writer for a later turn', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueueError(503, 'Private provider diagnostic');
    fixture.enqueue('Recovered');
    const session = await createOpenAIHarness({
      client: fixture.client,
      sessions: conversationSessions(fixture.client),
      model: 'gpt-4.1',
    }).openSession({ cwd: process.cwd() });
    try {
      const failed = await session.run({ content: [{ type: 'text', text: 'Fail' }] });
      const rejection = expect(failed.result).rejects.toThrow(/503/);
      const events = [];
      for await (const event of failed.events) events.push(event);
      await rejection;
      expect(events.at(-1)).toEqual({ type: EventType.RUN_ERROR, message: 'OpenAI run failed' });
      expect(JSON.stringify(events)).not.toContain('Private provider diagnostic');
      const next = await session.run({ content: [{ type: 'text', text: 'Retry' }] });
      expect((await next.result).status).toBe('completed');
    } finally {
      await session.dispose();
    }
  });

  it('does not release the writer before native history persistence finishes', async () => {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fixture = createOpenAIClientFixture({
      beforeRequest: async (request) => {
        if (request.method === 'POST' && request.path.endsWith('/items')) {
          reached.resolve();
          await release.promise;
        }
      },
    });
    fixture.enqueue('Answer');
    const session = await createOpenAIHarness({
      client: fixture.client,
      sessions: conversationSessions(fixture.client),
      model: 'gpt-4.1',
    }).openSession({ cwd: process.cwd() });
    const run = await session.run({ content: [{ type: 'text', text: 'Start' }] });
    let settled = false;
    const result = run.result.then(() => {
      settled = true;
    });
    try {
      await reached.promise;
      expect(settled).toBe(false);
      await expect(session.run({ content: [{ type: 'text', text: 'Overlap' }] })).rejects.toThrow(
        /active/,
      );
    } finally {
      release.resolve();
      await result;
      await session.dispose();
    }
  });

  it('preserves a native history write failure instead of publishing success', async () => {
    let failWrite = true;
    const fixture = createOpenAIClientFixture({
      beforeRequest: async (request) => {
        if (failWrite && request.method === 'POST' && request.path.endsWith('/items')) {
          failWrite = false;
          throw new Error('Private history diagnostic');
        }
      },
    });
    fixture.enqueue('Unsaved', 'Recovered');
    const session = await createOpenAIHarness({
      client: fixture.client,
      sessions: conversationSessions(fixture.client),
      model: 'gpt-4.1',
    }).openSession({ cwd: process.cwd() });
    try {
      const run = await session.run({ content: [{ type: 'text', text: 'Start' }] });
      const rejection = expect(run.result).rejects.toThrow();
      const events = [];
      for await (const event of run.events) events.push(event);
      await rejection;
      expect(events.at(-1)).toEqual({ type: EventType.RUN_ERROR, message: 'OpenAI run failed' });
      expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(false);
      const next = await session.run({ content: [{ type: 'text', text: 'Retry' }] });
      expect((await next.result).status).toBe('completed');
    } finally {
      await session.dispose();
    }
  });

  it('releases a failed native setup without leaving an active writer', async () => {
    let failRead = true;
    const fixture = createOpenAIClientFixture({
      beforeRequest: async (request) => {
        if (failRead && request.method === 'GET' && request.path.endsWith('/items')) {
          failRead = false;
          throw new Error('Private setup diagnostic');
        }
      },
    });
    fixture.enqueue('Recovered');
    const session = await createOpenAIHarness({
      client: fixture.client,
      sessions: conversationSessions(fixture.client),
      model: 'gpt-4.1',
    }).openSession({ cwd: process.cwd() });
    try {
      await expect(
        session.run({ content: [{ type: 'text', text: 'Fail setup' }] }),
      ).rejects.toThrow();
      const next = await session.run({ content: [{ type: 'text', text: 'Retry' }] });
      expect((await next.result).status).toBe('completed');
    } finally {
      await session.dispose();
    }
  });

  it('does not let an older interrupt handle cancel a newer active turn', async () => {
    let modelCalls = 0;
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fixture = createOpenAIClientFixture({
      beforeRequest: async (request) => {
        if (request.path === '/responses' && ++modelCalls === 2) {
          reached.resolve();
          await release.promise;
        }
      },
    });
    fixture.enqueue('First', 'Second');
    const session = await createOpenAIHarness({
      client: fixture.client,
      sessions: conversationSessions(fixture.client),
      model: 'gpt-4.1',
    }).openSession({ cwd: process.cwd() });
    const first = await session.run({ content: [{ type: 'text', text: 'First' }] });
    await first.result;
    const second = await session.run({ content: [{ type: 'text', text: 'Second' }] });
    try {
      await reached.promise;
      await first.interrupt();
    } finally {
      release.resolve();
    }
    expect((await second.result).status).toBe('completed');
    await session.dispose();
  });

  it('keeps a persistence failure rejected even after interruption was requested', async () => {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fixture = createOpenAIClientFixture({
      beforeRequest: async (request) => {
        if (request.method === 'POST' && request.path.endsWith('/items')) {
          reached.resolve();
          await release.promise;
          throw new Error('Independent persistence failure');
        }
      },
    });
    fixture.enqueue('Answer');
    const session = await createOpenAIHarness({
      client: fixture.client,
      sessions: conversationSessions(fixture.client),
      model: 'gpt-4.1',
    }).openSession({ cwd: process.cwd() });
    const run = await session.run({ content: [{ type: 'text', text: 'Start' }] });
    const rejection = expect(run.result).rejects.toThrow();
    try {
      await reached.promise;
      await run.interrupt();
    } finally {
      release.resolve();
    }
    await rejection;
    await session.dispose();
  });

  it('does not cancel native execution when the event observer closes early', async () => {
    const release = Promise.withResolvers<void>();
    const fixture = createOpenAIClientFixture({ pauseAfterText: release.promise });
    fixture.enqueue('Answer');
    const session = await createOpenAIHarness({
      client: fixture.client,
      sessions: conversationSessions(fixture.client),
      model: 'gpt-4.1',
    }).openSession({ cwd: process.cwd() });
    const run = await session.run({ content: [{ type: 'text', text: 'Start' }] });
    const observer = run.events[Symbol.asyncIterator]();
    await observer.next();
    await observer.next();
    await observer.next();
    try {
      await observer.return?.();
      await expect(session.run({ content: [{ type: 'text', text: 'Overlap' }] })).rejects.toThrow(
        /active/,
      );
    } finally {
      release.resolve();
    }
    expect((await run.result).status).toBe('completed');
    await session.dispose();
  });

  it('observes a failed execution even when neither result nor events are consumed', () => {
    // Node must remain alive when the host ignores both outputs; do not mask rejection in the child.
    const script = `
      import { setImmediate } from 'node:timers/promises';
      import { OpenAIConversationsSession } from '@openai/agents';
      import { createOpenAIHarness } from './src/index.ts';
      import { createOpenAIClientFixture } from './tests/fixtures/openai-client.ts';
      const reached = Promise.withResolvers();
      const fixture = createOpenAIClientFixture({ beforeRequest: async (request) => {
        if (request.path === '/responses') reached.resolve();
      } });
      fixture.enqueueError(503);
      const session = await createOpenAIHarness({
        client: fixture.client,
        model: 'gpt-4.1',
        sessions: {
          resumable: true,
          open: async (id) => new OpenAIConversationsSession({
            client: fixture.client,
            ...(id !== undefined ? { conversationId: id } : {}),
          }),
        },
      })
        .openSession({ cwd: process.cwd() });
      await session.run({ content: [{ type: 'text', text: 'Fail' }] });
      await reached.promise;
      await setImmediate();
      await session.dispose();
      await setImmediate();
      console.log('execution-observed');
    `;
    const output = execFileSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', script],
      {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        env: {},
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    expect(output.trim()).toBe('execution-observed');
  });

  it('fails an unknown remote identity lazily without replacing it with a new conversation', async () => {
    const fixture = createOpenAIClientFixture();
    const session = await createOpenAIHarness({
      client: fixture.client,
      sessions: conversationSessions(fixture.client),
      model: 'gpt-4.1',
    }).openSession({ cwd: process.cwd(), nativeSessionId: 'conv_missing' });
    try {
      expect(session.nativeSessionId).toBe('conv_missing');
      await expect(session.run({ content: [{ type: 'text', text: 'Start' }] })).rejects.toThrow();
      expect(fixture.requests.some((request) => request.method === 'POST')).toBe(false);
    } finally {
      await session.dispose();
    }
  });

  it('does not open storage for capabilities that are not connected yet', async () => {
    const fixture = createOpenAIClientFixture();
    const provider = createOpenAIHarness({
      client: fixture.client,
      sessions: conversationSessions(fixture.client),
      model: 'gpt-4.1',
    });

    await expect(
      provider.openSession({ cwd: process.cwd(), skills: { directories: ['skills'] } }),
    ).rejects.toThrow(/Skills/);
    await expect(
      provider.openSession({
        cwd: process.cwd(),
        mcpServers: [
          { name: 'reference', transport: 'streamable-http', url: 'https://mcp.example' },
        ],
      }),
    ).rejects.toThrow(/MCP/);
    await expect(
      provider.openSession({
        cwd: process.cwd(),
        tools: [
          {
            definition: { name: 'reference', inputSchema: { type: 'object' } },
            execute: async () => ({ content: [{ type: 'text', text: 'Unused' }] }),
          },
        ],
      }),
    ).rejects.toThrow(/Custom tools/);
    expect(fixture.requests).toEqual([]);
  });
});

/** Explicit SDK backend for the existing remote-history lifecycle regressions. */
function conversationSessions(client: OpenAI): OpenAISessions {
  return {
    resumable: true,
    open: async (nativeSessionId) =>
      new OpenAIConversationsSession({
        client,
        ...(nativeSessionId !== undefined ? { conversationId: nativeSessionId } : {}),
      }),
  };
}
