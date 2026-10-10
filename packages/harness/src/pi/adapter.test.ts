import { expect, it } from 'vitest';

import { createPiHarness } from '../index.js';

it('exposes the Pi provider without allocating a native session', () => {
  let opened = false;
  const harness = createPiHarness({
    resumable: false,
    open: async () => {
      opened = true;
      throw new Error('Opening must not happen');
    },
  });

  expect(harness.id).toBe('pi');
  expect(harness.resumable).toBe(false);
  expect(opened).toBe(false);
});

it('snapshots opening scope and history before asynchronous host allocation', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const request = { cwd: '/scope-a', nativeSessionId: 'history-a' };
  let observed: typeof request | undefined;
  const harness = createPiHarness({
    resumable: true,
    open: async (options) => {
      entered.resolve();
      await release.promise;
      observed = { cwd: options.cwd, nativeSessionId: options.nativeSessionId ?? '' };
      throw new Error('Host allocation rejected');
    },
  });
  const opening = harness.openSession(request);
  await entered.promise;

  request.cwd = '/scope-b';
  request.nativeSessionId = 'history-b';
  release.resolve();

  await expect(opening).rejects.toThrow('Host allocation rejected');
  expect(observed).toEqual({ cwd: '/scope-a', nativeSessionId: 'history-a' });
});
