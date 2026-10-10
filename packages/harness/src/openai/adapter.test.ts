import { Agent, MemorySession, Runner } from '@openai/agents';
import { assistantMessage, ScriptedModel } from '@openai/agents/testing';
import { expect, it } from 'vitest';

import type { OpenHarnessSessionOptions } from '../contract.js';
import { createOpenAIHarness } from './adapter.js';

function config(id = 'history') {
  const model = new ScriptedModel([[assistantMessage('Done', { id: 'answer' })]]);
  return {
    agent: new Agent({ name: 'Assistant', model }),
    runner: new Runner({ tracingDisabled: true }),
    session: new MemorySession({ sessionId: id }),
  };
}

it('opens only the native host configuration and preserves SDK execution', async () => {
  const native = config();
  const harness = createOpenAIHarness({ resumable: true, open: async () => native });
  const session = await harness.openSession({ cwd: '/authorized', nativeSessionId: 'history' });
  const result = await (await session.run({ content: [{ type: 'text', text: 'Start' }] })).result;
  expect(result.native.lastAgent).toBe(native.agent);
  expect(result.native.finalOutput).toBe('Done');
  await session.dispose();
});

it('snapshots opening scope and history before the host yields', async () => {
  const native = config();
  const opening = Promise.withResolvers<typeof native>();
  let forwarded: OpenHarnessSessionOptions | undefined;
  const harness = createOpenAIHarness({
    resumable: true,
    open: (request) => {
      forwarded = request;
      return opening.promise;
    },
  });
  const request = { cwd: '/authorized', nativeSessionId: 'history' };
  const pending = harness.openSession(request);
  request.cwd = '/different';
  request.nativeSessionId = 'different';
  opening.resolve(native);

  const session = await pending;
  expect(forwarded).toEqual({ cwd: '/authorized', nativeSessionId: 'history' });
  expect(session.nativeSessionId).toBe('history');
  await session.dispose();
});

it('does not let host mutation replace the requested history identity', async () => {
  const native = config('different');
  let releases = 0;
  const harness = createOpenAIHarness({
    resumable: true,
    open: async (request) => {
      request.nativeSessionId = 'different';
      return {
        ...native,
        dispose: () => {
          releases++;
        },
      };
    },
  });

  await expect(
    harness.openSession({ cwd: '/authorized', nativeSessionId: 'history' }),
  ).rejects.toThrow(/preserve the requested/);
  expect(releases).toBe(1);
});

it('keeps the returned binding while native history allocates its identity', async () => {
  const native = config();
  const replacement = config('replacement');
  const entered = Promise.withResolvers<void>();
  const identity = Promise.withResolvers<string>();
  native.session.getSessionId = () => {
    entered.resolve();
    return identity.promise;
  };
  let releases = 0;
  let replacementReleases = 0;
  const binding = {
    ...native,
    dispose: () => {
      releases++;
    },
  };
  const harness = createOpenAIHarness({ resumable: true, open: async () => binding });
  const opening = harness.openSession({ cwd: '/authorized', nativeSessionId: 'history' });
  await entered.promise;
  binding.agent = replacement.agent;
  binding.session = replacement.session;
  binding.dispose = () => {
    replacementReleases++;
  };
  identity.resolve('history');

  const session = await opening;
  const result = await (await session.run({ content: [{ type: 'text', text: 'Start' }] })).result;
  expect(result.native.lastAgent).toBe(native.agent);
  expect(await native.session.getItems()).toHaveLength(2);
  expect(await replacement.session.getItems()).toHaveLength(0);
  await session.dispose();
  expect(releases).toBe(1);
  expect(replacementReleases).toBe(0);
});

it('keeps validated run options while native history allocates its identity', async () => {
  const native = config();
  const entered = Promise.withResolvers<void>();
  const identity = Promise.withResolvers<string>();
  native.session.getSessionId = () => {
    entered.resolve();
    return identity.promise;
  };
  const runOptions: { maxTurns: number; context?: { injected: boolean } } = { maxTurns: 3 };
  const harness = createOpenAIHarness({
    resumable: true,
    open: async () => ({ ...native, runOptions }),
  });
  const opening = harness.openSession({ cwd: '/authorized', nativeSessionId: 'history' });
  await entered.promise;
  runOptions.context = { injected: true };
  identity.resolve('history');

  const session = await opening;
  const result = await (await session.run({ content: [{ type: 'text', text: 'Start' }] })).result;
  expect(result.native.runContext.context).not.toEqual({ injected: true });
  await session.dispose();
});

it('rejects history reopening before allocation if the host does not support it', async () => {
  let opened = false;
  const harness = createOpenAIHarness({
    resumable: false,
    open: async () => {
      opened = true;
      return config();
    },
  });
  await expect(
    harness.openSession({ cwd: '/authorized', nativeSessionId: 'history' }),
  ).rejects.toThrow(/resume/);
  expect(opened).toBe(false);
});

it('reports only the host history policy, not a second native capability inventory', () => {
  const harness = createOpenAIHarness({ resumable: true, open: async () => config() });
  expect(harness.resumable).toBe(true);
  expect(harness).not.toHaveProperty('capabilities');
});

it('supplies its native stream, history and signal without redundant option rejection', async () => {
  const native = config();
  const otherHistory = new MemorySession();
  const runOptions = {
    maxTurns: 3,
    stream: false,
    session: otherHistory,
    signal: AbortSignal.abort(),
  };
  const harness = createOpenAIHarness({
    resumable: false,
    open: async () => ({ ...native, runOptions }),
  });
  const session = await harness.openSession({ cwd: '/authorized' });
  const result = await (await session.run({ content: [{ type: 'text', text: 'Start' }] })).result;
  expect(result.native.finalOutput).toBe('Done');
  expect(await native.session.getItems()).toHaveLength(2);
  expect(await otherHistory.getItems()).toHaveLength(0);
  await session.dispose();
});

it('releases returned resources when the native history ID does not match', async () => {
  let released = false;
  const harness = createOpenAIHarness({
    resumable: true,
    open: async () => ({
      ...config('different'),
      dispose: () => {
        released = true;
      },
    }),
  });
  await expect(
    harness.openSession({ cwd: '/authorized', nativeSessionId: 'history' }),
  ).rejects.toThrow(/ID/);
  expect(released).toBe(true);
});

it('preserves both opening and cleanup failures', async () => {
  const cleanup = new Error('Cleanup failure');
  const harness = createOpenAIHarness({
    resumable: true,
    open: async () => ({
      ...config('different'),
      dispose: () => {
        throw cleanup;
      },
    }),
  });
  const error = await harness
    .openSession({ cwd: '/authorized', nativeSessionId: 'history' })
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) throw new Error('Expected an aggregate failure');
  expect(error.errors[1]).toBe(cleanup);
});

it('rejects invalid run options before accessing native history', async () => {
  const native = config();
  // A remote history backend may fail or allocate resources when its ID is requested.
  native.session.getSessionId = async () => {
    throw new Error('History unavailable');
  };
  const runOptions = { maxTurns: 3, context: undefined };
  const harness = createOpenAIHarness({
    resumable: true,
    open: async () => ({ ...native, runOptions }),
  });

  await expect(harness.openSession({ cwd: '/authorized' })).rejects.toThrow(/wrapper-owned/);
});

it('rejects wrapper-owned run options even through a structurally wider object', async () => {
  const runOptions = { maxTurns: 3, context: undefined };
  let released = false;
  const harness = createOpenAIHarness({
    resumable: true,
    open: async () => ({
      ...config(),
      runOptions,
      dispose: () => {
        released = true;
      },
    }),
  });
  await expect(harness.openSession({ cwd: '/authorized' })).rejects.toThrow(/wrapper-owned/);
  expect(released).toBe(true);
});
