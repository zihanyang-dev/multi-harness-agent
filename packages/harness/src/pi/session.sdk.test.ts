import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { TextMessageContentEvent, TextMessageStartEvent } from '@ag-ui/core';

import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  Type,
} from '@earendil-works/pi-ai';
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import type { HarnessTurnInput } from '../contract.js';
import { createPiHarness } from './adapter.js';

it('executes the native loop and records history without an event consumer', async () => {
  const { native, history, faux, session } = await setup();
  faux.setResponses([fauxAssistantMessage('Done')]);

  const run = await session.run({ content: [{ type: 'text', text: 'Start' }] });
  const result = await run.result;
  const entry = history
    .getBranch()
    .find((entry) => entry.type === 'message' && entry.message.role === 'assistant');

  expect(entry).toBeDefined();
  expect(result).toEqual({
    status: 'completed',
    messages: [{ id: entry?.id, role: 'assistant', content: 'Done' }],
  });
  expect(native.getLastAssistantText()).toBe('Done');
  expect(faux.state.callCount).toBe(1);
});

it('projects native history text with entry IDs and does not replay old messages', async () => {
  const { history, faux, session } = await setup();
  faux.setResponses([fauxAssistantMessage('First'), fauxAssistantMessage('Second')]);
  const first = await session.run({ content: [{ type: 'text', text: 'One' }] });
  await first.result;

  const run = await session.run({ content: [{ type: 'text', text: 'Two' }] });
  const events = [];
  for await (const event of run.events) events.push(event);
  const result = await run.result;
  const entry = history.getLeafEntry();

  expect(result.messages).toEqual([{ id: entry?.id, role: 'assistant', content: 'Second' }]);
  expect(events[0]).toMatchObject({ type: 'RUN_STARTED' });
  expect(events.at(-1)).toMatchObject({ type: 'RUN_FINISHED' });
  const chunks = events.filter((event) => event.type === 'TEXT_MESSAGE_CONTENT');
  expect(chunks.map((event) => (event as TextMessageContentEvent).delta).join('')).toBe('Second');
  const streamingId = (events[1] as TextMessageStartEvent).messageId;
  expect(streamingId).not.toBe(entry?.id);
  expect(events.at(-2)).toMatchObject({ type: 'TEXT_MESSAGE_END', messageId: streamingId });
});

it('keeps native tools and runs the genuine tool-result loop', async () => {
  let executions = 0;
  const parameters = Type.Object({ text: Type.String() });
  const echo: ToolDefinition<typeof parameters> = {
    name: 'echo',
    label: 'Echo',
    description: 'Echoes an authorized test value.',
    parameters,
    execute: async (_id, args) => {
      executions++;
      return { content: [{ type: 'text', text: args.text }], details: { executions } };
    },
  };
  const { history, faux, session } = await setup({ tools: [echo] });
  let toolResultObserved = false;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('echo', { text: 'hidden-marker' }, { id: 'echo-1' }), {
      stopReason: 'toolUse',
    }),
    (context) => {
      toolResultObserved = context.messages.some(
        (message) =>
          message.role === 'toolResult' &&
          message.toolCallId === 'echo-1' &&
          message.content.some((part) => part.type === 'text' && part.text === 'hidden-marker'),
      );
      return fauxAssistantMessage('Tool finished');
    },
  ]);

  const run = await session.run({ content: [{ type: 'text', text: 'Use echo' }] });
  const result = await run.result;

  expect(result.status).toBe('completed');
  expect(executions).toBe(1);
  expect(faux.state.callCount).toBe(2);
  expect(toolResultObserved).toBe(true);
  expect(history.getBranch()).toContainEqual(
    expect.objectContaining({
      type: 'message',
      message: expect.objectContaining({ role: 'toolResult', toolCallId: 'echo-1' }),
    }),
  );
});

it('rejects in-band model errors while keeping public errors sanitized and allowing a later turn', async () => {
  const { faux, session } = await setup();
  faux.setResponses([
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Private provider failure' }),
    fauxAssistantMessage('Recovered'),
  ]);
  const run = await session.run({ content: [{ type: 'text', text: 'Fail' }] });

  await expect(run.result).rejects.toMatchObject({
    message: 'Private provider failure',
    cause: expect.objectContaining({ stopReason: 'error' }),
  });
  const events = [];
  for await (const event of run.events) events.push(event);
  expect(events.at(-1)).toEqual({ type: 'RUN_ERROR', message: 'Pi run failed' });

  const next = await session.run({ content: [{ type: 'text', text: 'Retry as a new turn' }] });
  const result = await next.result;
  expect(result.status).toBe('completed');
  expect(result.messages.at(-1)?.content).toBe('Recovered');
});

it('rejects a second writer and cancels the owned native invocation', async () => {
  const { native, faux, session } = await setup();
  const entered = Promise.withResolvers<void>();
  faux.setResponses([waitForAbort(entered)]);
  const input: HarnessTurnInput = { content: [{ type: 'text', text: 'Wait' }] };
  const run = await session.run(input);
  await entered.promise;

  await expect(session.run(input)).rejects.toThrow(/active run/);
  await run.interrupt();

  expect((await run.result).status).toBe('cancelled');
  expect(native.isIdle).toBe(true);
});

it('honors interruption requested while native input preflight is pending', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const extension: ExtensionFactory = (pi) => {
    pi.on('input', async () => {
      entered.resolve();
      await release.promise;
      return { action: 'continue' };
    });
  };
  const { faux, session } = await setup({ extensions: [extension] });
  faux.setResponses([waitForAbort()]);
  const run = await session.run({ content: [{ type: 'text', text: 'Wait in preflight' }] });
  await entered.promise;

  const stopping = run.interrupt();
  release.resolve();
  await stopping;

  expect((await run.result).status).toBe('cancelled');
});

it('publishes one closing promise before native abort can reenter disposal', async () => {
  const { faux, session } = await setup();
  const entered = Promise.withResolvers<void>();
  let reentrant: Promise<void> | undefined;
  faux.setResponses([
    (_context, options) =>
      new Promise((resolve) => {
        const signal = options?.signal;
        if (signal === undefined) throw new Error('Expected native signal');
        signal.addEventListener(
          'abort',
          () => {
            reentrant = session.dispose();
            resolve(fauxAssistantMessage('', { stopReason: 'aborted' }));
          },
          { once: true },
        );
        entered.resolve();
      }),
  ]);
  const run = await session.run({ content: [{ type: 'text', text: 'Wait' }] });
  await entered.promise;

  const closing = session.dispose();
  await closing;

  expect(reentrant).toBe(closing);
  expect(session.dispose()).toBe(closing);
  expect((await run.result).status).toBe('cancelled');
  await expect(session.run({ content: [] })).rejects.toThrow(/disposed/);
});

it('rejects reopening before allocation when the host does not support it', async () => {
  let opened = false;
  const harness = createPiHarness({
    resumable: false,
    open: async () => {
      opened = true;
      throw new Error('Opening must not happen');
    },
  });

  await expect(
    harness.openSession({ cwd: '/authorized', nativeSessionId: 'history' }),
  ).rejects.toThrow(/resume/);
  expect(opened).toBe(false);
});

it('releases transferred resources on a history mismatch and retains cleanup failure', async () => {
  const { native } = await setup();
  const cleanup = new Error('Cleanup failure');
  let releases = 0;
  const harness = createPiHarness({
    resumable: true,
    open: async () => ({
      session: native,
      dispose: () => {
        releases++;
        throw cleanup;
      },
    }),
  });

  const error = await harness
    .openSession({ cwd: '/authorized', nativeSessionId: 'different' })
    .catch((error: unknown) => error);

  expect(error).toBeInstanceOf(AggregateError);
  expect(error).toMatchObject({ errors: [expect.any(Error), cleanup] });
  expect(releases).toBe(1);
});

it('does not let host mutation replace the requested history identity', async () => {
  const { native } = await setup();
  let releases = 0;
  const harness = createPiHarness({
    resumable: true,
    open: async (request) => {
      request.nativeSessionId = native.sessionId;
      return {
        session: native,
        dispose: () => {
          releases++;
        },
      };
    },
  });

  await expect(
    harness.openSession({ cwd: '/authorized', nativeSessionId: 'original-history' }),
  ).rejects.toThrow(/preserve the requested/);
  expect(releases).toBe(1);
});

it('reapplies an early interruption when native preflight compaction starts', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let compactionAborted = false;
  const extension: ExtensionFactory = (pi) => {
    pi.on('input', async () => {
      entered.resolve();
      await release.promise;
      return { action: 'continue' };
    });
    pi.on('session_before_compact', async (event) => {
      await new Promise<void>((resolve) => {
        if (event.signal.aborted) resolve();
        else event.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { cancel: true };
    });
  };
  const { native, faux, session } = await setup({
    extensions: [extension],
    initializeHistory: (history) => {
      history.appendMessage({
        role: 'user',
        content: 'Old context '.repeat(1_000),
        timestamp: Date.now(),
      });
      history.appendMessage(fauxAssistantMessage('Old answer'));
      history.appendMessage({
        role: 'user',
        content: 'Recent context '.repeat(32),
        timestamp: Date.now(),
      });
      const assistant = fauxAssistantMessage('Recent answer');
      assistant.usage = { ...assistant.usage, input: 1_000_000, totalTokens: 1_000_000 };
      history.appendMessage(assistant);
    },
  });
  expect(native.messages).toContainEqual(
    expect.objectContaining({
      role: 'assistant',
      usage: expect.objectContaining({ input: 1_000_000 }),
    }),
  );
  native.settingsManager.applyOverrides({
    compaction: { enabled: true, keepRecentTokens: 64, reserveTokens: 512 },
  });
  native.subscribe((event) => {
    if (event.type === 'compaction_end') compactionAborted = event.aborted;
  });
  faux.setResponses([waitForAbort()]);
  const run = await session.run({ content: [{ type: 'text', text: 'Continue' }] });
  await entered.promise;

  const stopping = run.interrupt();
  release.resolve();

  try {
    await expect.poll(() => compactionAborted, { timeout: 1_000 }).toBe(true);
    await stopping;
    expect((await run.result).status).toBe('cancelled');
  } finally {
    await session.dispose();
  }
});

it('releases transferred resources after a rejected native abort', async () => {
  const { native, faux, session } = await setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  faux.setResponses([
    async () => {
      entered.resolve();
      await release.promise;
      return fauxAssistantMessage('Finished');
    },
  ]);
  const run = await session.run({ content: [{ type: 'text', text: 'Wait' }] });
  await entered.promise;
  const failure = new Error('Injected native abort failure');
  const abort = vi.spyOn(native, 'abort').mockRejectedValue(failure);
  const dispose = vi.spyOn(native, 'dispose');
  try {
    const closing = session.dispose();
    release.resolve();
    await expect(closing).rejects.toBe(failure);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect((await run.result).status).toBe('completed');
  } finally {
    release.resolve();
    abort.mockRestore();
    dispose.mockRestore();
  }
});

it('preserves native retries without publishing failed-attempt text as a successful answer', async () => {
  const { native, faux, session } = await setup();
  native.settingsManager.applyOverrides({
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 10 },
  });
  faux.setResponses([
    fauxAssistantMessage('Failed-attempt text', {
      stopReason: 'error',
      errorMessage: '429 rate limit',
    }),
    fauxAssistantMessage('Recovered'),
  ]);

  const run = await session.run({ content: [{ type: 'text', text: 'Retry natively' }] });
  const result = await run.result;

  expect(result.status).toBe('completed');
  expect(result.messages.map((message) => message.content)).toEqual(['Recovered']);
  expect(faux.state.callCount).toBe(2);
  expect(native.sessionManager.getBranch()).toContainEqual(
    expect.objectContaining({
      type: 'message',
      message: expect.objectContaining({ stopReason: 'error' }),
    }),
  );
});

it('keeps native handled input as a completed action without inventing a model turn', async () => {
  const extension: ExtensionFactory = (pi) => {
    pi.on('input', async () => ({ action: 'handled' }));
  };
  const { faux, session } = await setup({ extensions: [extension] });

  const run = await session.run({ content: [{ type: 'text', text: 'Handled by native input' }] });

  expect(await run.result).toEqual({ status: 'completed', messages: [] });
  expect(faux.state.callCount).toBe(0);
});

it('an old interruption handle does not stop a later native invocation', async () => {
  const { native, faux, session } = await setup();
  const entered = Promise.withResolvers<void>();
  faux.setResponses([fauxAssistantMessage('First'), waitForAbort(entered)]);
  const first = await session.run({ content: [{ type: 'text', text: 'One' }] });
  await first.result;
  const next = await session.run({ content: [{ type: 'text', text: 'Two' }] });
  await entered.promise;

  await first.interrupt();

  expect(native.isIdle).toBe(false);
  await next.interrupt();
  expect((await next.result).status).toBe('cancelled');
});

it('projects native deferred completion without inventing an approval checkpoint', async () => {
  const { native, faux, session } = await setup();
  const model = faux.getModel();
  const deferred = {
    provider: model.provider,
    modelId: model.id,
    api: faux.api,
    id: 'native-deferred',
  };
  faux.setResponses([fauxAssistantMessage('', { stopReason: 'deferred', deferred })]);

  const run = await session.run({ content: [{ type: 'text', text: 'Defer natively' }] });

  expect(await run.result).toEqual({ status: 'paused', messages: [] });
  expect(native.messages).toContainEqual(
    expect.objectContaining({ stopReason: 'deferred', deferred }),
  );
  expect(faux.state.deferredFetchCount).toBe(0);
});

it('closing the event iterator leaves the native invocation running', async () => {
  const { native, faux, session } = await setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  faux.setResponses([
    async () => {
      entered.resolve();
      await release.promise;
      return fauxAssistantMessage('Done');
    },
  ]);
  const run = await session.run({ content: [{ type: 'text', text: 'Wait' }] });
  const reader = run.events[Symbol.asyncIterator]();
  await reader.next();
  await entered.promise;

  await reader.return?.();
  expect(native.isIdle).toBe(false);
  release.resolve();

  expect((await run.result).status).toBe('completed');
});

it('delivers native text while the owned prompt is pending, and observer overflow cannot break callbacks', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const extension: ExtensionFactory = (pi) => {
    pi.on('agent_end', async () => {
      entered.resolve();
      await release.promise;
    });
  };
  const { faux, session } = await setup({ extensions: [extension] });
  faux.setResponses([fauxAssistantMessage('Pending text')]);
  const run = await session.run({ content: [] });
  const events = run.events[Symbol.asyncIterator]();
  expect((await events.next()).value).toMatchObject({ type: 'RUN_STARTED' });
  expect((await events.next()).value).toMatchObject({ type: 'TEXT_MESSAGE_START' });
  expect((await events.next()).value).toMatchObject({ type: 'TEXT_MESSAGE_CONTENT' });
  await entered.promise;
  let settled = false;
  void run.result.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  await events.return?.();
  release.resolve();
  expect((await run.result).messages[0]?.content).toBe('Pending text');

  faux.setResponses([fauxAssistantMessage('word '.repeat(400))]);
  const overflow = await session.run({ content: [] });
  expect((await overflow.result).status).toBe('completed');
  const projected = [];
  for await (const event of overflow.events) projected.push(event);
  expect(projected.at(-1)).toMatchObject({
    type: 'RUN_ERROR',
    message: 'Pi event observation failed',
  });
});

async function setup(
  options: {
    extensions?: ExtensionFactory[];
    tools?: ToolDefinition[];
    initializeHistory?: (history: SessionManager) => void;
  } = {},
) {
  const home = process.env.PI_CODING_AGENT_DIR;
  if (home === undefined || process.env.PI_OFFLINE !== '1')
    throw new Error('Pi SDK checks require the isolated test process');
  const root = await mkdtemp(join(home, 'session-'));
  let native: AgentSession | undefined;
  let released = false;
  const dispose = () => {
    if (released) return;
    native?.dispose();
    released = true;
  };
  onTestFinished(async () => {
    try {
      if (!released) await native?.abort();
    } finally {
      try {
        dispose();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  const faux = fauxProvider({ tokenSize: { min: 1, max: 1 } });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    authPath: join(root, 'auth.json'),
    modelsPath: join(root, 'models.json'),
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  // Registration performs the SDK's required local-only catalog refresh.
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({
    cacheWarming: 'off',
    compaction: { enabled: false },
    retry: { enabled: false, provider: { maxRetries: 0 } },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: options.extensions ?? [],
  });
  await resourceLoader.reload();
  const history = SessionManager.inMemory(root);
  options.initializeHistory?.(history);
  const created = await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime,
    model: faux.getModel(),
    thinkingLevel: 'off',
    settingsManager,
    resourceLoader,
    sessionManager: history,
    tools: options.tools?.map((tool) => tool.name) ?? [],
    customTools: options.tools ?? [],
  });
  native = created.session;
  await native.bindExtensions({});
  const harness = createPiHarness({
    resumable: true,
    open: async () => ({ session: created.session, dispose }),
  });
  const session = await harness.openSession({ cwd: root, nativeSessionId: native.sessionId });
  return { native, history, faux, session };
}

function waitForAbort(entered?: PromiseWithResolvers<void>): FauxResponseFactory {
  return (_context, options) =>
    new Promise((resolve) => {
      const signal = options?.signal;
      if (signal === undefined) throw new Error('Expected native signal');
      const finish = () => resolve(fauxAssistantMessage('', { stopReason: 'aborted' }));
      if (signal.aborted) finish();
      else signal.addEventListener('abort', finish, { once: true });
      entered?.resolve();
    });
}
