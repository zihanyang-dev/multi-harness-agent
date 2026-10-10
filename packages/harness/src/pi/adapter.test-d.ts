import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { expectTypeOf } from 'vitest';

import {
  type CreatePiHarnessOptions,
  createPiHarness,
  type HarnessSession,
  type PiHarnessPromptOptions,
  type PiSessionConfig,
} from '../index.js';

declare const native: AgentSession;
const config: PiSessionConfig = { session: native };
const options: CreatePiHarnessOptions = { resumable: false, open: async () => config };
const harness = createPiHarness(options);

expectTypeOf(harness.id).toEqualTypeOf<'pi'>();
expectTypeOf(harness.openSession).returns.resolves.toEqualTypeOf<HarnessSession>();
expectTypeOf(config.session).toEqualTypeOf<AgentSession>();

const promptOptions: PiHarnessPromptOptions = {
  source: 'extension',
  expandPromptTemplates: false,
  // @ts-expect-error Ordered input, not host options, owns attachments.
  images: [],
};
void promptOptions;
