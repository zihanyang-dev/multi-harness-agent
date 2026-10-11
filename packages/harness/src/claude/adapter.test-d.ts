import type { Query, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { expectTypeOf } from 'vitest';

import {
  type ClaudeHarness,
  type ClaudeRun,
  type ClaudeSession,
  type ClaudeSessionConfig,
  type ClaudeTurnResult,
  type CreateClaudeHarnessOptions,
  createClaudeHarness,
} from '../index.js';
import { createClaudeHarness as createSubpathHarness } from './adapter.js';

declare const native: Query;
const config: ClaudeSessionConfig = { query: native, nativeSessionId: 'authorized-native-id' };
const options: CreateClaudeHarnessOptions = {
  resumable: false,
  open: async (_request, prompt) => {
    expectTypeOf(prompt).toEqualTypeOf<AsyncIterable<SDKUserMessage>>();
    return config;
  },
};
const harness = createClaudeHarness(options);
expectTypeOf(harness).toEqualTypeOf<ClaudeHarness>();
expectTypeOf(harness.id).toEqualTypeOf<'claude'>();
expectTypeOf(harness.openSession).returns.resolves.toEqualTypeOf<ClaudeSession>();
expectTypeOf(config.query).toEqualTypeOf<Query>();
expectTypeOf<ClaudeSession['run']>().returns.resolves.toEqualTypeOf<ClaudeRun>();
expectTypeOf<ClaudeRun['result']>().resolves.toEqualTypeOf<ClaudeTurnResult>();
expectTypeOf<ClaudeTurnResult['native']>().toEqualTypeOf<SDKResultMessage>();
expectTypeOf(createSubpathHarness).toEqualTypeOf(createClaudeHarness);
