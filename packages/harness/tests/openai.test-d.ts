import type { Session } from '@openai/agents';
import type OpenAI from 'openai';

import type { CreateOpenAIHarnessOptions, OpenAISessions } from '../src/index.js';

// Checked by the harness TypeScript project; no clients or sessions are created here.
declare const client: OpenAI;
declare const nativeSession: Session;

const sessions: OpenAISessions = {
  resumable: false,
  open: async () => nativeSession,
};

export const configuredHarness: CreateOpenAIHarnessOptions = {
  client,
  model: 'configured-model',
  sessions,
  modelSettings: { store: false },
};

// @ts-expect-error Session backend selection is required rather than an implicit default.
export const implicitBackend: CreateOpenAIHarnessOptions = { client, model: 'configured-model' };

export const incompatibleSession: OpenAISessions = {
  resumable: false,
  // @ts-expect-error A business identity is not an implementation of the SDK Session protocol.
  open: async () => ({ nativeSessionId: 'business-thread' }),
};
