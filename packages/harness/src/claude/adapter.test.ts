import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { expect, it } from 'vitest';

import { createClaudeHarness } from './adapter.js';

it('rejects unsupported or empty resume IDs before allocating native resources', async () => {
  let allocations = 0;
  const harness = createClaudeHarness({
    resumable: false,
    open: async () => {
      allocations += 1;
      throw new Error('Unexpected allocation');
    },
  });
  await expect(
    harness.openSession({ cwd: '/workspace', nativeSessionId: 'saved' }),
  ).rejects.toThrow('does not support resume');
  await expect(harness.openSession({ cwd: '/workspace', nativeSessionId: '  ' })).rejects.toThrow(
    'must not be empty',
  );
  expect(allocations).toBe(0);
});

it('wakes the persistent input when the host rejects partial opening', async () => {
  let inputEnded: Promise<IteratorResult<unknown>> | undefined;
  const cause = new Error('Host setup failed');
  const harness = createClaudeHarness({
    resumable: false,
    open: async (_options, prompt) => {
      inputEnded = prompt[Symbol.asyncIterator]().next();
      throw cause;
    },
  });
  await expect(harness.openSession({ cwd: '/workspace' })).rejects.toBe(cause);
  expect(await inputEnded).toEqual({ done: true, value: undefined });
});

it.each(['', 'different'])(
  'releases a returned binding rejected by identity validation: %s',
  async (nativeSessionId) => {
    const stages: string[] = [];
    const harness = createClaudeHarness({
      resumable: true,
      open: async (_request, prompt) => {
        const ended = prompt[Symbol.asyncIterator]().next();
        // Only transferred cleanup capabilities are exercised; no native Query is executed here.
        const query = {
          close: () => {
            stages.push('close');
          },
          return: async () => {
            expect(await ended).toEqual({ done: true, value: undefined });
            stages.push('return');
            return { done: true as const, value: undefined };
          },
        } as Query;
        return {
          query,
          nativeSessionId,
          dispose: () => {
            stages.push('host');
          },
        };
      },
    });
    await expect(
      harness.openSession({ cwd: '/workspace', nativeSessionId: 'authorized' }),
    ).rejects.toThrow(nativeSessionId === '' ? 'must not be empty' : 'did not preserve');
    expect(stages).toEqual(['close', 'return', 'host']);
  },
);

it('retains opening and every independent transferred cleanup failure', async () => {
  const stages: string[] = [];
  const closeError = new Error('Close failed');
  const returnError = new Error('Return failed');
  const hostError = new Error('Host cleanup failed');
  const cleanup: Pick<Query, 'close' | 'return'> = {
    close: () => {
      stages.push('close');
      throw closeError;
    },
    return: async () => {
      stages.push('return');
      throw returnError;
    },
  };
  const harness = createClaudeHarness({
    resumable: false,
    open: async () => ({
      nativeSessionId: '',
      query: cleanup as Query,
      dispose: () => {
        stages.push('host');
        throw hostError;
      },
    }),
  });
  await expect(harness.openSession({ cwd: '/workspace' })).rejects.toMatchObject({
    errors: [
      expect.objectContaining({ message: 'Claude native session ID must not be empty' }),
      closeError,
      returnError,
      hostError,
    ],
  });
  expect(stages).toEqual(['close', 'return', 'host']);
});

it('retains the factory binding and does not pass the caller-owned request across await', async () => {
  const called = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const request = { cwd: '/workspace', nativeSessionId: 'authorized' };
  let received: typeof request | undefined;
  const cause = new Error('Host deliberately refused');
  const source = {
    resumable: true,
    open: async (options: { cwd: string; nativeSessionId?: string }) => {
      received = options as typeof request;
      called.resolve();
      await release.promise;
      throw cause;
    },
  };
  const harness = createClaudeHarness(source);
  source.resumable = false;
  source.open = async () => {
    throw new Error('Changed factory');
  };
  const opening = harness.openSession(request);
  await called.promise;
  request.cwd = '/changed';
  request.nativeSessionId = 'changed';
  expect(received).toEqual({ cwd: '/workspace', nativeSessionId: 'authorized' });
  release.resolve();
  await expect(opening).rejects.toBe(cause);
});
