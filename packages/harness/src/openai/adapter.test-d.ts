import { Agent, MemorySession, Runner, type RunState } from '@openai/agents';
import { assistantMessage, ScriptedModel } from '@openai/agents/testing';
import { expectTypeOf } from 'vitest';
import { z } from 'zod';

import { createOpenAIHarness, type OpenAIHarnessRunOptions } from '../index.js';

const context = { count: 0 };
const schema = z.object({ count: z.number() });
const agent = new Agent<typeof context, typeof schema>({
  name: 'Typed assistant',
  outputType: schema,
  model: new ScriptedModel([[assistantMessage('{"count":1}', { id: 'answer' })]]),
});
const harness = createOpenAIHarness({
  resumable: false,
  open: async () => ({
    agent,
    context,
    runner: new Runner({ tracingDisabled: true }),
    session: new MemorySession(),
  }),
});
const session = await harness.openSession({ cwd: '/test' });
const result = await (await session.run({ content: [{ type: 'text', text: 'Start' }] })).result;

expectTypeOf(result.native.finalOutput).toEqualTypeOf<{ count: number } | undefined>();
// @ts-expect-error Native output must retain its concrete schema, not become any.
result.native.finalOutput?.missing;

await session.resume({
  result: result.native,
  updateState: (state) => {
    expectTypeOf(state).toEqualTypeOf<RunState<typeof context, typeof agent>>();
  },
});

const options: OpenAIHarnessRunOptions<typeof context, typeof agent> = {
  maxTurns: 2,
  // @ts-expect-error Streaming ownership is not a host run option.
  stream: true,
};
void options;
