import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import type { Api, Model } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { createPiHarness, type PiSessionConfig } from '@multi-harness/harness/pi';
import { type PiBinding, PiBindingSchema } from '@multi-harness/protocol/execution';
import { z } from 'zod';
import type { PiTurnHost } from '../../contract.js';
import { createWebSearchTool, type WebSearchOptions } from './web-search.js';

/** Snapshots reviewed identity/policy; the borrowed SDK owns the loop, history and compaction. */
export function createPiTurnHost(options: {
  binding: PiBinding;
  stateRoot: string;
  modelRuntime: ModelRuntime;
  webSearch?: WebSearchOptions;
}): PiTurnHost {
  const binding = Object.freeze(PiBindingSchema.parse(options.binding));
  if ((binding.policy === 'web-search-v1') !== (options.webSearch !== undefined))
    throw new Error('Pi search policy and private tool configuration must agree');
  const webSearchTool = options.webSearch ? createWebSearchTool(options.webSearch) : undefined;
  if (!isAbsolute(options.stateRoot)) throw new Error('Pi stateRoot must be absolute and private');
  const stateRoot = resolve(options.stateRoot);
  const modelRuntime = options.modelRuntime;
  const model = modelRuntime.getPhysicalModel(binding.provider, binding.model);
  if (model === undefined)
    throw new Error('Pi binding model is unsupported by the supplied runtime');

  return {
    binding,
    async openSession({ threadId, nativeSessionId }) {
      if (!z.uuid().safeParse(threadId).success) throw new Error('Pi thread ID must be a UUID');
      const threadRoot = join(stateRoot, threadId);
      const cwd = join(threadRoot, 'workspace');
      const harness = createPiHarness({
        resumable: true,
        open: () =>
          openNativeSession({
            threadRoot,
            cwd,
            nativeSessionId,
            modelRuntime,
            model,
            webSearchTool,
          }),
      });
      return harness.openSession({
        cwd,
        ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
      });
    },
  };
}

async function openNativeSession(options: {
  threadRoot: string;
  cwd: string;
  nativeSessionId: string | undefined;
  modelRuntime: ModelRuntime;
  model: Model<Api>;
  webSearchTool: ReturnType<typeof createWebSearchTool> | undefined;
}): Promise<PiSessionConfig> {
  const { threadRoot, cwd, nativeSessionId, modelRuntime, model } = options;
  const sessionsDir = join(threadRoot, 'sessions');
  const agentDir = join(threadRoot, 'agent');

  // Resolve exact native header IDs before creating any directories or replacement history.
  const sessionPath =
    nativeSessionId === undefined
      ? undefined
      : SessionManager.findById(cwd, nativeSessionId, sessionsDir);
  if (nativeSessionId !== undefined && sessionPath === undefined)
    throw new Error('Pi native session ID not found');
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const sessionManager =
    sessionPath === undefined
      ? SessionManager.create(cwd, sessionsDir)
      : SessionManager.open(sessionPath, sessionsDir);

  // Pi owns retry and compaction; other budgets and delays retain SDK 1.1.0 defaults.
  const settingsManager = SettingsManager.inMemory({
    cacheWarming: 'off',
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 3 },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    settingsManager,
    resourceLoader,
    sessionManager,
    tools: options.webSearchTool ? ['web_search'] : [],
    customTools: options.webSearchTool ? [options.webSearchTool] : [],
  });

  // Transfer disposal to the adapter, which joins its prompt before releasing the session.
  return {
    session,
    publicTools: options.webSearchTool ? ['web_search'] : [],
    promptOptions: { expandPromptTemplates: false },
    dispose: () => session.dispose(),
  };
}
