import {
  Agent,
  handoff,
  MemorySession,
  OpenAIResponsesModel,
  type RunContext,
  Runner,
  RunResult,
  type Session,
  tool,
} from '@openai/agents';
import {
  assistantMessage,
  functionCall,
  modelError,
  modelResponder,
  modelStreamResponder,
  ScriptedModel,
} from '@openai/agents/testing';
import OpenAI, { APIUserAbortError } from 'openai';
import { expect, it } from 'vitest';
import { z } from 'zod';

import type { HarnessTurnInput } from '../contract.js';
import { createOpenAISession } from './session.js';

const input: HarnessTurnInput = { content: [{ type: 'text', text: 'Start' }] };

function setup(model: ScriptedModel, tools: Agent['tools'] = []) {
  const history = new MemorySession({ sessionId: 'history' });
  const agent = new Agent({ name: 'Assistant', model, tools });
  const runner = new Runner({ tracingDisabled: true });
  const session = createOpenAISession({ agent, runner, session: history }, 'history');
  return { session, history, agent, runner };
}

function recordTool(execute: () => string) {
  return tool({
    name: 'record',
    description: 'Records an authorized operation.',
    parameters: z.object({}),
    needsApproval: true,
    execute,
  });
}

it('executes the SDK loop and persists history without an observer', async () => {
  const model = new ScriptedModel([[assistantMessage('Done', { id: 'answer' })]]);
  const { session, history } = setup(model);

  const run = await session.run(input);
  const result = await run.result;

  expect(result.status).toBe('completed');
  expect(result.messages).toEqual([{ id: 'answer', role: 'assistant', content: 'Done' }]);
  expect(result.native).toBeInstanceOf(RunResult);
  expect(result.native.finalOutput).toBe('Done');
  expect(result.native).not.toHaveProperty('toStream');
  expect(await history.getItems()).toHaveLength(2);
  model.assertComplete();
  await session.dispose();
});

it('preserves native context and structured output through a real tool loop', async () => {
  const context = { tenant: 'test', count: 0 };
  let observed: typeof context | undefined;
  const schema = z.object({ count: z.number() });
  const model = new ScriptedModel([
    [functionCall('record', {}, { callId: 'record-1' })],
    [assistantMessage('{"count":1}', { id: 'answer' })],
  ]);
  const agent = new Agent<typeof context, typeof schema>({
    name: 'Assistant',
    model,
    outputType: schema,
    tools: [
      tool({
        name: 'record',
        description: 'Records in this context.',
        parameters: z.object({}),
        execute: (_args, native?: RunContext<typeof context>) => {
          observed = native?.context;
          if (native === undefined) throw new Error('Expected native context');
          native.context.count++;
          return String(native.context.count);
        },
      }),
    ],
  });
  const session = createOpenAISession(
    { agent, context, runner: new Runner({ tracingDisabled: true }), session: new MemorySession() },
    'history',
  );

  const result = await (await session.run(input)).result;
  expect(observed).toBe(context);
  expect(context.count).toBe(1);
  expect(result.native.finalOutput).toEqual({ count: 1 });
  model.assertComplete();
  await session.dispose();
});

it('resumes a handoff interruption on the original root graph', async () => {
  let executions = 0;
  const rootModel = new ScriptedModel([
    [functionCall('delegate_record', {}, { callId: 'delegate-1' })],
  ]);
  const specialistModel = new ScriptedModel([
    [functionCall('record', {}, { callId: 'record-1' })],
    [assistantMessage('Specialist completed', { id: 'answer' })],
  ]);
  const specialist = new Agent({
    name: 'Specialist',
    model: specialistModel,
    tools: [recordTool(() => String(++executions))],
  });
  const root = new Agent({
    name: 'Root',
    model: rootModel,
    handoffs: [handoff(specialist, { toolNameOverride: 'delegate_record' })],
  });
  const session = createOpenAISession(
    { agent: root, runner: new Runner({ tracingDisabled: true }), session: new MemorySession() },
    'history',
  );

  const paused = await (await session.run(input)).result;
  expect(paused.status).toBe('paused');
  expect(paused.native.lastAgent).toBe(specialist);
  const result = await (
    await session.resume({
      result: paused.native,
      updateState: (state) => {
        for (const request of state.getInterruptions()) state.approve(request);
      },
    })
  ).result;
  expect(result.native.finalOutput).toBe('Specialist completed');
  expect(result.native.lastAgent).toBe(specialist);
  expect(executions).toBe(1);
  rootModel.assertComplete();
  specialistModel.assertComplete();
  await session.dispose();
});

it('lets the SDK propagate and resume nested agent tool approvals', async () => {
  let executions = 0;
  const nestedModel = new ScriptedModel([
    [functionCall('record', {}, { callId: 'nested-record' })],
    [assistantMessage('Nested completed', { id: 'nested-answer' })],
  ]);
  const nested = new Agent({
    name: 'Nested',
    model: nestedModel,
    tools: [recordTool(() => String(++executions))],
  });
  const rootModel = new ScriptedModel([
    [functionCall('delegate', { input: 'Record' }, { callId: 'delegate-1' })],
    [assistantMessage('Root completed', { id: 'root-answer' })],
  ]);
  const { session } = setup(rootModel, [
    nested.asTool({ toolName: 'delegate', toolDescription: 'Delegates recording.' }),
  ]);
  const paused = await (await session.run(input)).result;
  expect(paused.status).toBe('paused');
  expect(executions).toBe(0);
  const result = await (
    await session.resume({
      result: paused.native,
      updateState: (state) => {
        for (const request of state.getInterruptions()) state.approve(request);
      },
    })
  ).result;
  expect(result.native.finalOutput).toBe('Root completed');
  expect(executions).toBe(1);
  nestedModel.assertComplete();
  rootModel.assertComplete();
  await session.dispose();
});

it('continues an SDK cancellation without duplicating the original user input', async () => {
  const entered = Promise.withResolvers<void>();
  const model = new ScriptedModel([
    modelStreamResponder((call) =>
      (async function* () {
        const signal = call.request.signal;
        if (signal === undefined) throw new Error('Expected an execution signal');
        entered.resolve();
        if (!signal.aborted)
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
        throw new DOMException('Interrupted', 'AbortError');
      })(),
    ),
    [assistantMessage('Continued', { id: 'answer' })],
  ]);
  const { session, history } = setup(model);
  const run = await session.run(input);
  await entered.promise;
  await run.interrupt();
  const cancelled = await run.result;
  expect(cancelled.status).toBe('cancelled');
  expect(session.pendingRun).toBe(cancelled.native);
  const continued = await (await session.resume({ result: cancelled.native })).result;
  expect(continued.native.finalOutput).toBe('Continued');
  expect(
    (await history.getItems()).filter((item) => 'role' in item && item.role === 'user'),
  ).toHaveLength(1);
  model.assertComplete();
  await session.dispose();
});

it('does not disguise an unrecognized native abort failure as successful cancellation', async () => {
  const entered = Promise.withResolvers<void>();
  const failure = new APIUserAbortError();
  const model = new ScriptedModel([
    modelStreamResponder((call) =>
      (async function* () {
        const signal = call.request.signal;
        if (signal === undefined) throw new Error('Expected an execution signal');
        entered.resolve();
        if (!signal.aborted)
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
        throw failure;
      })(),
    ),
  ]);
  const { session } = setup(model);
  const run = await session.run(input);
  await entered.promise;
  await run.interrupt();
  await expect(run.result).rejects.toBe(failure);
  await expect(session.run(input)).rejects.toThrow(/failed/);
  model.assertComplete();
  await session.dispose();
});

it('uses the real Responses converter and client for ordered file requests', async () => {
  const requests: unknown[] = [];
  const client = new OpenAI({
    apiKey: 'offline-placeholder',
    baseURL: 'https://offline.invalid/v1',
    maxRetries: 0,
    fetch: async (url, init) => {
      requests.push(await new Request(url, init).json());
      return new Response(
        JSON.stringify({
          error: { message: 'Offline transport rejection', type: 'invalid_request_error' },
        }),
        {
          status: 400,
          headers: { 'content-type': 'application/json' },
        },
      );
    },
  });
  const session = createOpenAISession(
    {
      agent: new Agent({
        name: 'Assistant',
        model: new OpenAIResponsesModel(client, 'offline-model'),
      }),
      runner: new Runner({ tracingDisabled: true }),
      session: new MemorySession(),
    },
    'history',
  );
  const run = await session.run({
    content: [
      { type: 'text', text: 'Before' },
      { type: 'file', source: new Uint8Array([65]), mimeType: 'image/png' },
      { type: 'text', text: 'Between' },
      {
        type: 'file',
        source: new URL('https://files.example/document'),
        mimeType: 'application/pdf',
      },
      {
        type: 'file',
        source: new Uint8Array([66]),
        mimeType: 'application/pdf',
        filename: 'report.pdf',
      },
    ],
  });
  await expect(run.result).rejects.toThrow(/Offline transport rejection/);
  expect(requests).toEqual([
    expect.objectContaining({
      input: [
        expect.objectContaining({
          role: 'user',
          content: [
            { type: 'input_text', text: 'Before' },
            { type: 'input_image', image_url: 'data:image/png;base64,QQ==', detail: 'auto' },
            { type: 'input_text', text: 'Between' },
            { type: 'input_file', file_url: 'https://files.example/document' },
            {
              type: 'input_file',
              file_data: 'data:application/pdf;base64,Qg==',
              filename: 'report.pdf',
            },
          ],
        }),
      ],
    }),
  ]);
  await session.dispose();
});

it('keeps native success usable when assistant content has no stable message ID', async () => {
  const anonymous = assistantMessage('Native answer');
  delete anonymous.id;
  const model = new ScriptedModel([[anonymous], [assistantMessage('Next answer', { id: 'next' })]]);
  const { session, history } = setup(model);

  const first = await (await session.run(input)).result;
  expect(first.status).toBe('completed');
  expect(first.native.finalOutput).toBe('Native answer');
  expect(first.messages).toEqual([]);
  expect(await history.getItems()).toHaveLength(2);
  expect((await (await session.run(input)).result).native.finalOutput).toBe('Next answer');
  model.assertComplete();
  await session.dispose();
});

it('takes ownership of a host-restored native continuation', async () => {
  let executions = 0;
  const model = new ScriptedModel([
    [functionCall('record', {}, { callId: 'record-1' })],
    [assistantMessage('Restored', { id: 'answer' })],
  ]);
  const {
    agent,
    runner,
    history,
    session: unused,
  } = setup(model, [recordTool(() => String(++executions))]);
  await unused.dispose();
  const paused = await runner.run<typeof agent, unknown>(agent, 'Start', { session: history });
  const session = createOpenAISession(
    { agent, runner, session: history, runState: paused.state },
    'history',
  );

  const pending = session.pendingRun;
  expect(pending?.state).toBe(paused.state);
  if (pending === undefined) throw new Error('Expected a restored continuation');
  const run = await session.resume({
    result: pending,
    updateState: (state) => {
      for (const request of state.getInterruptions()) state.approve(request);
    },
  });

  expect((await run.result).native.finalOutput).toBe('Restored');
  expect(executions).toBe(1);
  model.assertComplete();
  await session.dispose();
});

it('observes text with native identifiers and a single terminal event', async () => {
  const model = new ScriptedModel([[assistantMessage('Done', { id: 'answer' })]]);
  const { session } = setup(model);
  const run = await session.run(input);
  const events = [];
  for await (const event of run.events) events.push(event);

  expect(events).toEqual([
    expect.objectContaining({ type: 'RUN_STARTED' }),
    { type: 'TEXT_MESSAGE_START', messageId: 'answer', role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'answer', delta: 'Done' },
    { type: 'TEXT_MESSAGE_END', messageId: 'answer' },
    expect.objectContaining({ type: 'RUN_FINISHED', outcome: { type: 'success' } }),
  ]);
  await run.result;
  model.assertComplete();
  await session.dispose();
});

it('returns a settled pause and resumes approvals on the original SDK state', async () => {
  let executions = 0;
  const model = new ScriptedModel([
    [functionCall('record', {}, { callId: 'record-1' })],
    [assistantMessage('Recorded', { id: 'answer' })],
  ]);
  const { session, history } = setup(model, [recordTool(() => String(++executions))]);

  const paused = await (await session.run(input)).result;
  expect(paused.status).toBe('paused');
  expect(session.pendingRun).toBe(paused.native);
  expect(executions).toBe(0);
  await expect(session.run(input)).rejects.toThrow(/pending/);

  const run = await session.resume({
    result: paused.native,
    updateState: (state) => {
      for (const request of state.getInterruptions()) state.approve(request);
    },
  });
  const resumed = await run.result;

  expect(resumed.status).toBe('completed');
  expect(resumed.native.state).toBe(paused.native.state);
  expect(resumed.native).not.toBe(paused.native);
  expect(executions).toBe(1);
  expect(
    (await history.getItems()).filter((item) => 'role' in item && item.role === 'user'),
  ).toHaveLength(1);
  await expect(session.resume({ result: paused.native })).rejects.toThrow(/stale|another/);
  model.assertComplete();
  await session.dispose();
});

it('lets the SDK reject a call without running its tool', async () => {
  let executions = 0;
  const model = new ScriptedModel([
    [functionCall('record', {}, { callId: 'record-1' })],
    [assistantMessage('Rejected', { id: 'answer' })],
  ]);
  const { session } = setup(model, [recordTool(() => String(++executions))]);
  const paused = await (await session.run(input)).result;

  const run = await session.resume({
    result: paused.native,
    updateState: (state) => {
      for (const request of state.getInterruptions())
        state.reject(request, { message: 'Not authorized' });
    },
  });

  expect((await run.result).status).toBe('completed');
  expect(executions).toBe(0);
  expect(model.lastCall?.request.input).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'function_call_result',
        output: { type: 'text', text: 'Not authorized' },
      }),
    ]),
  );
  model.assertComplete();
  await session.dispose();
});

it('reserves the writer before native execution starts', async () => {
  const gate = Promise.withResolvers<void>();
  const model = new ScriptedModel([
    modelResponder(async () => {
      await gate.promise;
      return [assistantMessage('First', { id: 'first' })];
    }),
    [assistantMessage('Second', { id: 'second' })],
  ]);
  const { session } = setup(model);

  const first = await session.run(input);
  await expect(session.run(input)).rejects.toThrow(/active/);
  gate.resolve();
  await first.result;
  expect((await (await session.run(input)).result).native.finalOutput).toBe('Second');
  model.assertComplete();
  await session.dispose();
});

it('closing observation does not cancel execution', async () => {
  const gate = Promise.withResolvers<void>();
  const model = new ScriptedModel([
    modelResponder(async () => {
      await gate.promise;
      return [assistantMessage('Done', { id: 'answer' })];
    }),
  ]);
  const { session } = setup(model);
  const run = await session.run(input);
  const observer = run.events[Symbol.asyncIterator]();
  await observer.next();
  await observer.return?.();
  gate.resolve();

  expect((await run.result).status).toBe('completed');
  model.assertComplete();
  await session.dispose();
});

it('closing an acquired native reader leaves the SDK tool loop running', async () => {
  const gate = Promise.withResolvers<void>();
  const model = new ScriptedModel([
    [
      assistantMessage('Before tool', { id: 'before' }),
      functionCall('record', {}, { callId: 'record-1' }),
    ],
    [assistantMessage('Done', { id: 'answer' })],
  ]);
  const { session } = setup(model, [
    tool({
      name: 'record',
      description: 'Waits for the test resource.',
      parameters: z.object({}),
      execute: async () => {
        await gate.promise;
        return 'Recorded';
      },
    }),
  ]);
  const run = await session.run(input);
  const observer = run.events[Symbol.asyncIterator]();
  expect((await observer.next()).value).toMatchObject({ type: 'RUN_STARTED' });
  expect((await observer.next()).value).toMatchObject({
    type: 'TEXT_MESSAGE_START',
    messageId: 'before',
  });
  await observer.return?.();
  gate.resolve();

  expect((await run.result).native.finalOutput).toBe('Done');
  expect((await run.result).status).toBe('completed');
  model.assertComplete();
  await session.dispose();
});

it('preserves SDK history initialization errors and releases local admission', async () => {
  const failure = new Error('History initialization failed');
  const model = new ScriptedModel([[assistantMessage('Unused')]]);
  const history = new MemorySession();
  history.getItems = async () => {
    throw failure;
  };
  let cleanups = 0;
  const session = createOpenAISession(
    {
      agent: new Agent({ name: 'Assistant', model }),
      runner: new Runner({ tracingDisabled: true }),
      session: history,
      dispose: () => {
        cleanups++;
      },
    },
    'history',
  );

  await expect(session.run(input)).rejects.toBe(failure);
  await expect(session.run(input)).rejects.toThrow(/failed/);
  await session.dispose();
  expect(cleanups).toBe(1);
  expect(model.calls).toHaveLength(0);
});

it('retains native errors and blocks unsafe execution after failure', async () => {
  const failure = new Error('Private model failure');
  const model = new ScriptedModel([modelError(failure)]);
  const { session } = setup(model);
  const run = await session.run(input);

  await expect(run.result).rejects.toBe(failure);
  const events = [];
  for await (const event of run.events) events.push(event);
  expect(events.at(-1)).toEqual({ type: 'RUN_ERROR', message: 'OpenAI run failed' });
  await expect(session.run(input)).rejects.toThrow(/failed/);
  model.assertComplete();
  await session.dispose();
});

it('blocks reuse after input and approvals mutate before an updater throws', async () => {
  const failure = new Error('Updater failed');
  const model = new ScriptedModel([[functionCall('record', {}, { callId: 'record-1' })]]);
  const { session } = setup(model, [recordTool(() => 'Recorded')]);
  const paused = await (await session.run(input)).result;
  await expect(
    session.resume({
      result: paused.native,
      input: { content: [{ type: 'text', text: 'Extra' }] },
      updateState: (state) => {
        for (const request of state.getInterruptions()) state.approve(request);
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
  expect(paused.native.state.pendingInput).toHaveLength(1);
  await expect(session.resume({ result: paused.native })).rejects.toThrow(/failed/);
  model.assertComplete();
  await session.dispose();
});

it('rejects asynchronous updaters without leaving an unobserved rejection', async () => {
  const model = new ScriptedModel([[functionCall('record', {}, { callId: 'record-1' })]]);
  const { session } = setup(model, [recordTool(() => 'Recorded')]);
  const paused = await (await session.run(input)).result;
  await expect(
    session.resume({
      result: paused.native,
      // @ts-expect-error Exercise the JavaScript boundary, not an accepted async API.
      updateState: async () => {
        throw new Error('Async updater failed');
      },
    }),
  ).rejects.toThrow(/synchronous/);
  await expect(session.resume({ result: paused.native })).rejects.toThrow(/failed/);
  model.assertComplete();
  await session.dispose();
});

it('keeps a failed resume blocked even after the SDK consumes its interruptions', async () => {
  let executions = 0;
  const failure = new Error('Model failed after tool effects');
  const model = new ScriptedModel([
    [functionCall('record', {}, { callId: 'record-1' })],
    modelError(failure),
  ]);
  const { session } = setup(model, [recordTool(() => String(++executions))]);
  const paused = await (await session.run(input)).result;
  const run = await session.resume({
    result: paused.native,
    updateState: (state) => {
      for (const request of state.getInterruptions()) state.approve(request);
    },
  });
  await expect(run.result).rejects.toBe(failure);
  expect(executions).toBe(1);
  expect(paused.native.interruptions).toHaveLength(0);
  await expect(session.resume({ result: paused.native })).rejects.toThrow(/failed/);
  model.assertComplete();
  await session.dispose();
});

it('supports partial approvals without replaying prior assistant observations', async () => {
  let executions = 0;
  const model = new ScriptedModel([
    [
      assistantMessage('Before approval', { id: 'before' }),
      functionCall('record', {}, { callId: 'record-1' }),
      functionCall('record', {}, { callId: 'record-2' }),
    ],
    [assistantMessage('After approval', { id: 'after' })],
  ]);
  const { session } = setup(model, [recordTool(() => String(++executions))]);
  const first = await (await session.run(input)).result;
  const partial = await (
    await session.resume({
      result: first.native,
      updateState: (state) => {
        for (const request of state.getInterruptions()) {
          if (request.rawItem.type === 'function_call' && request.rawItem.callId === 'record-1')
            state.approve(request);
        }
      },
    })
  ).result;
  expect(partial.status).toBe('paused');
  expect(partial.messages).toEqual([]);
  expect(executions).toBe(1);
  await expect(session.resume({ result: first.native })).rejects.toThrow(/stale/);

  const run = await session.resume({
    result: partial.native,
    updateState: (state) => {
      for (const request of state.getInterruptions()) state.approve(request);
    },
  });
  const completed = await run.result;
  expect(completed.messages).toEqual([
    { id: 'after', role: 'assistant', content: 'After approval' },
  ]);
  expect(
    completed.native.newItems.filter((item) => item.type === 'message_output_item'),
  ).toHaveLength(2);
  const events = [];
  for await (const event of run.events) events.push(event);
  expect(events.filter((event) => event.type === 'TEXT_MESSAGE_START')).toEqual([
    { type: 'TEXT_MESSAGE_START', messageId: 'after', role: 'assistant' },
  ]);
  expect(executions).toBe(2);
  model.assertComplete();
  await session.dispose();
});

it('holds the writer while a synchronous updater calls back into the session', async () => {
  const model = new ScriptedModel([
    [functionCall('record', {}, { callId: 'record-1' })],
    [assistantMessage('Done', { id: 'answer' })],
  ]);
  const { session } = setup(model, [recordTool(() => 'Recorded')]);
  const paused = await (await session.run(input)).result;
  let conflict: Promise<unknown> | undefined;
  const run = await session.resume({
    result: paused.native,
    updateState: (state) => {
      conflict = session.run(input);
      void conflict.catch(() => undefined);
      for (const request of state.getInterruptions()) state.approve(request);
    },
  });
  await expect(conflict).rejects.toThrow(/active/);
  expect((await run.result).status).toBe('completed');
  model.assertComplete();
  await session.dispose();
});

it('memoizes disposal before a native abort listener reenters the session', async () => {
  const entered = Promise.withResolvers<void>();
  let reentered: Promise<void> | undefined;
  let cleanups = 0;
  const model = new ScriptedModel([
    modelStreamResponder((call) =>
      (async function* () {
        const signal = call.request.signal;
        if (signal === undefined) throw new Error('Expected an execution signal');
        entered.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              reentered = session.dispose();
              resolve();
            },
            { once: true },
          ),
        );
        throw new DOMException('Interrupted', 'AbortError');
      })(),
    ),
  ]);
  const session = createOpenAISession(
    {
      agent: new Agent({ name: 'Assistant', model }),
      runner: new Runner({ tracingDisabled: true }),
      session: new MemorySession(),
      dispose: () => {
        cleanups++;
      },
    },
    'history',
  );
  const run = await session.run(input);
  await entered.promise;
  const closing = session.dispose();
  await closing;

  expect(reentered).toBe(closing);
  expect(cleanups).toBe(1);
  expect((await run.result).status).toBe('cancelled');
  model.assertComplete();
});

it('joins SDK persistence before releasing owned resources exactly once', async () => {
  const history = new MemorySession();
  const writing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const nativeHistory: Session = {
    getSessionId: () => history.getSessionId(),
    getItems: (limit) => history.getItems(limit),
    popItem: () => history.popItem(),
    clearSession: () => history.clearSession(),
    addItems: async (items) => {
      if (items.some((item) => 'role' in item && item.role === 'assistant')) {
        writing.resolve();
        await release.promise;
      }
      await history.addItems(items);
    },
  };
  const model = new ScriptedModel([[assistantMessage('Done', { id: 'answer' })]]);
  let releases = 0;
  const session = createOpenAISession(
    {
      agent: new Agent({ name: 'Assistant', model }),
      runner: new Runner({ tracingDisabled: true }),
      session: nativeHistory,
      dispose: () => {
        releases++;
      },
    },
    'history',
  );
  const run = await session.run(input);
  await writing.promise;
  const closing = session.dispose();
  expect(session.dispose()).toBe(closing);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(releases).toBe(0);
  await expect(session.run(input)).rejects.toThrow(/disposed/);
  release.resolve();
  await closing;
  expect((await run.result).status).toBe('cancelled');
  expect(releases).toBe(1);
  expect(await history.getItems()).toHaveLength(2);
  model.assertComplete();
});
