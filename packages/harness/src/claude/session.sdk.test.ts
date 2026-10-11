import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { EventType } from '@ag-ui/core';
import {
  type Query,
  query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, expect, it } from 'vitest';

import { createClaudeHarness } from './adapter.js';

type SubmittedMessage = SDKUserMessage & { uuid: NonNullable<SDKUserMessage['uuid']> };

const resources: Query[] = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.close();
    await resource.return();
  }
});

it('runs ordered text without an event observer and retains one native query across turns', async () => {
  const { session, child, native } = await openFixture();
  const firstPart = { type: 'text' as const, text: 'first ' };
  const input = { content: [firstPart, { type: 'text' as const, text: 'second' }] };
  const run = await session.run(input);
  firstPart.text = 'mutated';
  const sent = await child.nextUser();
  expect(sent.message.content).toBe('first second');
  child.send(assistant(child.id, '00000000-0000-4000-8000-000000000001', 'reply'));
  const receipt = result(child.id, sent.uuid);
  receipt.user_message_uuids = [sent.uuid];
  delete receipt.user_message_uuid;
  child.send(receipt);
  expect(await run.result).toMatchObject({
    status: 'completed',
    messages: [{ id: '00000000-0000-4000-8000-000000000001', content: 'reply' }],
    native: receipt,
  });

  const second = await session.run({ content: [{ type: 'text', text: 'next' }] });
  const secondSent = await child.nextUser();
  expect(secondSent.uuid).not.toBe(sent.uuid);
  child.send(result(child.id, secondSent.uuid));
  expect((await second.result).messages).toEqual([]);
  expect(native).toBe(resources[0]);
  await session.dispose();
});

it('closing public observation does not close execution', async () => {
  const { session, child } = await openFixture();
  const run = await session.run({ content: [{ type: 'text', text: 'work' }] });
  const events = run.events[Symbol.asyncIterator]();
  expect((await events.next()).value).toMatchObject({ type: EventType.RUN_STARTED });
  await events.return?.();
  const sent = await child.nextUser();
  child.send(assistant(child.id, '00000000-0000-4000-8000-000000000002', 'still running'));
  child.send(result(child.id, sent.uuid));
  expect((await run.result).messages).toEqual([
    { id: '00000000-0000-4000-8000-000000000002', role: 'assistant', content: 'still running' },
  ]);
  expect(child.exitCode).toBeNull();
  await session.dispose();
});

it('does not release the writer on an interrupt ACK or cancel a newer turn from an old handle', async () => {
  const { session, child } = await openFixture();
  const run = await session.run({ content: [{ type: 'text', text: 'work' }] });
  const sent = await child.nextUser();
  await expect(session.run({ content: [] })).rejects.toThrow('active run');
  await run.interrupt();
  await expect(session.run({ content: [] })).rejects.toThrow('active run');
  child.send(result(child.id, sent.uuid, { terminal_reason: 'aborted_tools' }));
  expect((await run.result).status).toBe('cancelled');

  const second = await session.run({ content: [] });
  const next = await child.nextUser();
  const interrupts = child.interrupts;
  await run.interrupt();
  expect(child.interrupts).toBe(interrupts);
  child.send(result(child.id, next.uuid));
  expect((await second.result).status).toBe('completed');
  await session.dispose();
});

it('keeps the writer until a delayed interrupt ACK fences the completed turn', async () => {
  const { session, child } = await openFixture();
  child.holdInterrupt = true;
  const run = await session.run({ content: [] });
  const sent = await child.nextUser();
  const stopping = run.interrupt();
  void stopping.catch(() => undefined);
  await child.interruptReceived.promise;
  let settled = false;
  void run.result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  child.send(result(child.id, sent.uuid));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  await expect(session.run({ content: [] })).rejects.toThrow('active run');
  child.finishInterrupt();
  await stopping;
  expect((await run.result).status).toBe('completed');
  const next = await session.run({ content: [] });
  const nextSent = await child.nextUser();
  child.send(result(child.id, nextSent.uuid));
  await next.result;
  await session.dispose();
});

it('does not yield an admission gap for a late interrupt while settling an un-interrupted receipt', async () => {
  let lateInterrupt = () => {};
  let receiptObserved = false;
  const { session, child } = await openFixture(undefined, (native) => {
    const iterator = native[Symbol.asyncIterator]();
    const originalNext = iterator.next.bind(iterator);
    iterator.next = async (...args) => {
      const frame = await originalNext(...args);
      if (frame.value?.type === 'result') {
        receiptObserved = true;
        // Queue after reader admission, before an unnecessary await of an absent fence resumes.
        queueMicrotask(() => queueMicrotask(lateInterrupt));
      }
      return frame;
    };
  });
  child.holdInterrupt = true;
  const run = await session.run({ content: [] });
  const sent = await child.nextUser();
  lateInterrupt = () => {
    void run.interrupt().catch(() => undefined);
  };
  try {
    child.send(assistant(child.id, '00000000-0000-4000-8000-000000000008', 'done'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.send(result(child.id, sent.uuid));
    await run.result;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(receiptObserved).toBe(true);
    expect(child.interrupts).toBe(0);
  } finally {
    if (child.interrupts > 0) child.finishInterrupt();
    await session.dispose();
  }
});

it('fails closed when an interrupt fence rejects after the native result', async () => {
  const { session, child } = await openFixture();
  child.holdInterrupt = true;
  const run = await session.run({ content: [] });
  const sent = await child.nextUser();
  const stopping = run.interrupt();
  void stopping.catch(() => undefined);
  await child.interruptReceived.promise;
  child.send(result(child.id, sent.uuid));
  await new Promise<void>((resolve) => setImmediate(resolve));
  child.finishInterrupt('Native interrupt delivery failed');
  await expect(stopping).rejects.toThrow('Native interrupt delivery failed');
  await expect(run.result).rejects.toThrow('Native interrupt delivery failed');
  await expect(session.run({ content: [] })).rejects.toThrow(/closed|failed/);
  await expect(session.dispose()).rejects.toThrow('Native interrupt delivery failed');
});

it('fails closed on a rejected interrupt ACK without waiting for another native receipt', async () => {
  const { session, child } = await openFixture();
  child.holdInterrupt = true;
  const run = await session.run({ content: [] });
  await child.nextUser();
  const stopping = run.interrupt();
  void stopping.catch(() => undefined);
  await child.interruptReceived.promise;
  child.finishInterrupt('Native interrupt delivery failed');
  await expect(stopping).rejects.toThrow('Native interrupt delivery failed');
  let settled = false;
  void run.result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(true);
  await expect(run.result).rejects.toThrow('Native interrupt delivery failed');
  await expect(session.run({ content: [] })).rejects.toThrow(/closed|failed/);
  await expect(session.dispose()).rejects.toThrow('Native interrupt delivery failed');
});

it('reports completion when the native turn completes despite an interrupt request', async () => {
  const { session, child } = await openFixture();
  const run = await session.run({ content: [] });
  const sent = await child.nextUser();
  await run.interrupt();
  child.send(result(child.id, sent.uuid));
  expect((await run.result).status).toBe('completed');
  await session.dispose();
});

it.each([
  { subtype: 'success' as const, is_error: true, result: 'private API failure' },
  { subtype: 'error_max_turns' as const, is_error: true, errors: ['private limit failure'] },
])('rejects native error results and redacts public errors: $subtype', async (failure) => {
  const { session, child } = await openFixture();
  const run = await session.run({ content: [] });
  const sent = await child.nextUser();
  child.send(result(child.id, sent.uuid, failure));
  await expect(run.result).rejects.toMatchObject({ cause: expect.objectContaining(failure) });
  const events = [];
  for await (const event of run.events) events.push(event);
  expect(events.at(-1)).toEqual({ type: EventType.RUN_ERROR, message: 'Claude run failed' });
  const recovered = await session.run({ content: [] });
  const next = await child.nextUser();
  child.send(result(child.id, next.uuid));
  expect((await recovered.result).status).toBe('completed');
  await session.dispose();
});

it.each([
  'other-session',
  'other-prompt',
  'missing-prompt',
  'multiple-prompts',
  'empty-prompts',
  'queued-turn',
])('fails closed on unexpected native identity: %s', async (kind) => {
  const { session, child } = await openFixture();
  const run = await session.run({ content: [] });
  const sent = await child.nextUser();
  const receipt = result(
    kind === 'other-session' ? randomUUID() : child.id,
    kind === 'other-prompt' ? randomUUID() : sent.uuid,
  );
  if (kind === 'missing-prompt') delete receipt.user_message_uuid;
  if (kind === 'multiple-prompts') receipt.user_message_uuids = [sent.uuid, randomUUID()];
  if (kind === 'empty-prompts') receipt.user_message_uuids = [];
  if (kind === 'queued-turn') receipt.queued_turn_count = 1;
  child.send(receipt);
  await expect(run.result).rejects.toThrow(/identity|attribution/);
  await expect(session.run({ content: [] })).rejects.toThrow(/failed|closed/);
  await session.dispose();
});

it('rejects process EOF without a result rather than inventing success', async () => {
  const { session, child } = await openFixture();
  const run = await session.run({ content: [] });
  await child.nextUser();
  child.exit(0);
  await expect(run.result).rejects.toThrow(/closed|result/);
  await expect(session.run({ content: [] })).rejects.toThrow(/closed|failed/);
  await session.dispose();
});

it('wakes input and closes a pending query before joining disposal exactly once', async () => {
  let cleanups = 0;
  const { session, child } = await openFixture(() => {
    cleanups += 1;
  });
  const run = await session.run({ content: [] });
  await child.nextUser();
  const closing = session.dispose();
  expect(session.dispose()).toBe(closing);
  await closing;
  await expect(run.result).rejects.toThrow(/closed|result/);
  expect(child.exitCode).toBe(0);
  expect(cleanups).toBe(1);
  await expect(session.run({ content: [] })).rejects.toThrow('disposed');
});

it('still joins the native cleanup receipt when close throws, and retains host cleanup failure', async () => {
  const hostError = new Error('Host cleanup failed');
  const closeError = new Error('Native close failed');
  let hostClosed = false;
  const { session, native } = await openFixture(() => {
    hostClosed = true;
    throw hostError;
  });
  const release = Promise.withResolvers<void>();
  const originalClose = native.close.bind(native);
  const originalReturn = native.return.bind(native);
  native.close = () => {
    throw closeError;
  };
  native.return = async () => {
    await release.promise;
    return originalReturn();
  };
  try {
    const closing = session.dispose();
    void closing.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(hostClosed).toBe(false);
    release.resolve();
    await expect(closing).rejects.toMatchObject({ errors: [closeError, hostError] });
  } finally {
    release.resolve();
    native.close = originalClose;
    native.return = originalReturn;
  }
});

it('joins the owned reader even when the native return receipt rejects', async () => {
  const releaseReader = Promise.withResolvers<void>();
  let hostClosed = false;
  const { session, native } = await openFixture(
    () => {
      hostClosed = true;
    },
    (query) => {
      const iterator = query[Symbol.asyncIterator]();
      const next = iterator.next.bind(iterator);
      iterator.next = async (...args) => {
        const frame = await next(...args);
        if (frame.done) await releaseReader.promise;
        return frame;
      };
    },
  );
  const cause = new Error('Native return failed');
  const originalReturn = native.return.bind(native);
  native.return = async () => {
    throw cause;
  };
  try {
    const closing = session.dispose();
    void closing.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(hostClosed).toBe(false);
    releaseReader.resolve();
    await expect(closing).rejects.toBe(cause);
    expect(hostClosed).toBe(true);
  } finally {
    releaseReader.resolve();
    native.return = originalReturn;
  }
});

it('rejects files before native input is submitted and leaves the session usable', async () => {
  const { session, child } = await openFixture();
  await expect(
    session.run({
      content: [{ type: 'file', source: new Uint8Array([1]), mimeType: 'image/png' }],
    }),
  ).rejects.toThrow('text only');
  const run = await session.run({ content: [] });
  const sent = await child.nextUser();
  expect(sent.message.content).toBe('');
  child.send(result(child.id, sent.uuid));
  expect((await run.result).status).toBe('completed');
  await session.dispose();
});

it('projects split blocks by wire UUID without leaking tools or subagent text', async () => {
  const { session, child } = await openFixture();
  const run = await session.run({ content: [] });
  const sent = await child.nextUser();
  const old = assistant(child.id, '00000000-0000-4000-8000-000000000003', 'retracted');
  child.send(old);
  child.send(
    assistant(child.id, '00000000-0000-4000-8000-000000000004', 'hello ', {
      supersedes: [old.uuid],
    }),
  );
  child.send(assistant(child.id, '00000000-0000-4000-8000-000000000005', 'world'));
  child.send(
    assistant(child.id, '00000000-0000-4000-8000-000000000006', 'private nested', {
      parent_tool_use_id: 'tool',
    }),
  );
  child.send(result(child.id, sent.uuid, { result: 'hello world' }));
  expect((await run.result).messages).toEqual([
    { id: '00000000-0000-4000-8000-000000000004', role: 'assistant', content: 'hello ' },
    { id: '00000000-0000-4000-8000-000000000005', role: 'assistant', content: 'world' },
  ]);
  const events = [];
  for await (const event of run.events) events.push(event);
  expect(
    events
      .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => event.delta),
  ).toEqual(['hello ', 'world']);
  expect(events.at(-1)).toMatchObject({
    type: EventType.RUN_FINISHED,
    outcome: { type: 'success' },
  });
  await session.dispose();
});

it('evicts refusal text from the native resolution notice without needing another assistant frame', async () => {
  const { session, child } = await openFixture();
  const run = await session.run({ content: [] });
  const sent = await child.nextUser();
  const refused = assistant(child.id, '00000000-0000-4000-8000-000000000007', 'stale refusal');
  child.send(refused);
  child.send({
    type: 'system',
    subtype: 'model_refusal_fallback',
    uuid: randomUUID(),
    session_id: child.id,
    trigger: 'refusal',
    direction: 'retry',
    original_model: 'primary',
    fallback_model: 'fallback',
    request_id: null,
    content: '',
    retracted_message_uuids: [refused.uuid],
  });
  child.send(result(child.id, sent.uuid));
  expect((await run.result).messages).toEqual([]);
  await session.dispose();
});

it('retains a native deferred receipt rather than inventing a portable continuation', async () => {
  const { session, child } = await openFixture();
  const run = await session.run({ content: [] });
  const sent = await child.nextUser();
  child.send(result(child.id, sent.uuid, { terminal_reason: 'tool_deferred' }));
  expect((await run.result).status).toBe('paused');
  await session.dispose();
});

async function openFixture(
  dispose?: () => void | Promise<void>,
  configure?: (native: Query) => void,
) {
  if (process.env.MHA_CLAUDE_OFFLINE !== '1')
    throw new Error('Claude SDK checks require the isolated test process');
  const child = new OfflineProcess();
  let native: Query | undefined;
  const harness = createClaudeHarness({
    resumable: false,
    open: async ({ cwd }, prompt) => {
      native = query({
        prompt,
        options: {
          cwd,
          sessionId: child.id,
          settingSources: [],
          strictMcpConfig: true,
          tools: [],
          env: { HOME: process.env.HOME, PATH: process.env.PATH },
          spawnClaudeCodeProcess: () => child,
        },
      });
      resources.push(native);
      await native.initializationResult();
      configure?.(native);
      return {
        query: native,
        nativeSessionId: child.id,
        ...(dispose === undefined ? {} : { dispose }),
      };
    },
  });
  const home = process.env.HOME;
  if (home === undefined) throw new Error('Missing isolated HOME');
  const session = await harness.openSession({ cwd: home });
  if (native === undefined) throw new Error('Missing allocated Query');
  return { session, child, native };
}

/** Replaces only the process/IO boundary; the installed Query and transport stay real. */
class OfflineProcess extends EventEmitter implements SpawnedProcess {
  readonly id = randomUUID();
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  interrupts = 0;
  holdInterrupt = false;
  readonly interruptReceived = Promise.withResolvers<void>();
  private heldInterrupt: string | undefined;
  private users: SubmittedMessage[] = [];
  private waiting: PromiseWithResolvers<SubmittedMessage> | undefined;

  constructor() {
    super();
    let buffer = '';
    this.stdin.on('data', (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const frame = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (frame.type === 'user') {
          if (typeof frame.uuid !== 'string') throw new Error('Missing submitted prompt UUID');
          if (this.waiting === undefined) this.users.push(frame);
          else {
            this.waiting.resolve(frame);
            this.waiting = undefined;
          }
        } else if (frame.type === 'control_request') {
          if (frame.request.subtype === 'interrupt') {
            this.interrupts += 1;
            this.interruptReceived.resolve();
            if (this.holdInterrupt) {
              this.heldInterrupt = frame.request_id;
              newline = buffer.indexOf('\n');
              continue;
            }
          }
          this.stdout.write(
            `${JSON.stringify({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: frame.request_id,
                response:
                  frame.request.subtype === 'initialize'
                    ? {
                        commands: [],
                        agents: [],
                        models: [],
                        account: {},
                        output_style: 'default',
                        available_output_styles: [],
                      }
                    : {},
              },
            })}\n`,
          );
        }
        newline = buffer.indexOf('\n');
      }
    });
    this.stdin.on('finish', () => this.exit(0));
  }

  nextUser(): Promise<SubmittedMessage> {
    const message = this.users.shift();
    if (message !== undefined) return Promise.resolve(message);
    this.waiting = Promise.withResolvers<SubmittedMessage>();
    return this.waiting.promise;
  }

  finishInterrupt(error?: string): void {
    this.stdout.write(
      `${JSON.stringify({
        type: 'control_response',
        response:
          error === undefined
            ? { subtype: 'success', request_id: this.heldInterrupt, response: {} }
            : { subtype: 'error', request_id: this.heldInterrupt, error },
      })}\n`,
    );
    this.heldInterrupt = undefined;
  }

  send(message: SDKMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
  kill(): boolean {
    this.killed = true;
    this.exit(0);
    return true;
  }
  exit(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.stdout.end();
    this.emit('exit', code, null);
  }
}

function assistant(
  id: string,
  uuid: SDKAssistantMessage['uuid'],
  text: string,
  extra: Partial<SDKAssistantMessage> = {},
): SDKAssistantMessage {
  return {
    type: 'assistant',
    uuid,
    session_id: id,
    parent_tool_use_id: null,
    message: {
      id: 'shared-api-message',
      type: 'message',
      role: 'assistant',
      model: 'offline',
      content: [{ type: 'text', text, citations: null }],
      stop_reason: null,
      stop_sequence: null,
      container: null,
      context_management: null,
      diagnostics: null,
      stop_details: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: null,
        service_tier: null,
        cache_creation: null,
        inference_geo: null,
        iterations: null,
        speed: null,
        fallback_credit: null,
        output_tokens_details: null,
      },
    },
    ...extra,
  };
}

function result(
  id: string,
  prompt: string,
  extra: Partial<SDKResultMessage> = {},
): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    uuid: randomUUID(),
    session_id: id,
    user_message_uuid: prompt,
    is_error: false,
    result: '',
    stop_reason: 'end_turn',
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      service_tier: 'standard',
      inference_geo: '',
      iterations: [],
      speed: 'standard',
    },
    modelUsage: {},
    permission_denials: [],
    ...extra,
  } as SDKResultMessage;
}
