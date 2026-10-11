import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  fauxAssistantMessage,
  fauxProvider,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { PiBinding } from '@multi-harness/protocol/execution';
import { expect, it, onTestFinished } from 'vitest';

it('exports the host constructor', async () => {
  const host = await import('./host.js');
  expect(host.createPiTurnHost).toBeTypeOf('function');
});

async function setup() {
  if (
    process.env.MHA_PI_HOST_FIXTURE !== '1' ||
    process.env.PI_OFFLINE !== '1' ||
    !process.env.PI_CODING_AGENT_DIR
  )
    throw new Error('Host SDK tests require the isolated fixture process');
  const root = await mkdtemp(join(process.env.PI_CODING_AGENT_DIR, 'host-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider({ tokenSize: { min: 1, max: 1 } });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    authPath: join(root, 'auth.json'),
    modelsPath: join(root, 'models.json'),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = faux.getModel();
  const binding: PiBinding = {
    harness: 'pi',
    sdkVersion: '1.1.0',
    provider: model.provider,
    model: model.id,
    policy: 'text-v1',
    storageId: 'private-worker',
  };
  const { createPiTurnHost } = await import('./host.js');
  const host = createPiTurnHost({ binding, stateRoot: join(root, 'state'), modelRuntime });
  return { root, faux, binding, host, modelRuntime, createPiTurnHost };
}

it('persists native context and reopens the exact ID with a fresh host', async () => {
  const { host, root, faux, binding, modelRuntime, createPiTurnHost } = await setup();
  const threadId = randomUUID();
  const session = await host.openSession({ threadId });
  onTestFinished(() => session.dispose());
  faux.setResponses([
    fauxAssistantMessage('First answer'),
    (context, _options, _state, model) => {
      expect(model.provider).toBe(binding.provider);
      expect(model.id).toBe(binding.model);
      expect(context.messages).toContainEqual(
        expect.objectContaining({
          role: 'user',
          content: [{ type: 'text', text: 'First prompt' }],
        }),
      );
      expect(context.messages).toContainEqual(
        expect.objectContaining({
          role: 'assistant',
          content: [{ type: 'text', text: 'First answer' }],
        }),
      );
      expect(
        context.messages.flatMap((m) => (m.role === 'system' ? (m.toolsAdded ?? []) : [])),
      ).toEqual([]);
      return fauxAssistantMessage('Second answer');
    },
  ]);
  await (await session.run({ content: [{ type: 'text', text: 'First prompt' }] })).result;
  await session.dispose();
  const fresh = createPiTurnHost({ binding, stateRoot: join(root, 'state'), modelRuntime });
  const resumed = await fresh.openSession({ threadId, nativeSessionId: session.nativeSessionId });
  onTestFinished(() => resumed.dispose());
  expect(resumed.nativeSessionId).toBe(session.nativeSessionId);
  await expect(
    fresh.openSession({ threadId: randomUUID(), nativeSessionId: session.nativeSessionId }),
  ).rejects.toThrow(/not found/i);
  expect(
    (
      await (
        await resumed.run({ content: [{ type: 'text', text: 'Second prompt' }] })
      ).result
    ).messages.map((m) => m.content),
  ).toEqual(['Second answer']);
  expect(faux.state.callCount).toBe(2);
  expect(
    (await readdir(join(root, 'state', threadId, 'sessions'))).filter((p) => p.endsWith('.jsonl')),
  ).toHaveLength(1);
});

it('rejects invalid thread IDs before filesystem IO and rejects missing history without creating a replacement', async () => {
  const { host, root } = await setup();
  for (const threadId of ['../escape', '/tmp/escape', '', 'not-a-uuid'])
    await expect(host.openSession({ threadId })).rejects.toThrow(/thread.*UUID/i);
  await expect(access(join(root, 'state'))).rejects.toThrow();
  await expect(
    host.openSession({ threadId: randomUUID(), nativeSessionId: randomUUID() }),
  ).rejects.toThrow(/not found/i);
});

it('snapshots binding metadata and rejects unsupported models and relative storage', async () => {
  const { host, binding, modelRuntime, createPiTurnHost, root } = await setup();
  const original = { ...binding };
  binding.model = 'changed';
  expect(host.binding).toEqual(original);
  expect(() =>
    createPiTurnHost({ binding: original, stateRoot: 'relative', modelRuntime }),
  ).toThrow(/absolute/i);
  expect(() =>
    createPiTurnHost({ binding: { ...original, model: 'missing' }, stateRoot: root, modelRuntime }),
  ).toThrow(/model/i);
  expect(() =>
    createPiTurnHost({
      binding: { ...original, policy: 'other' } as unknown as PiBinding,
      stateRoot: root,
      modelRuntime,
    }),
  ).toThrow();
});

it('has no tools or discovered context and returning an observer does not stop execution', async () => {
  const { host, faux, root } = await setup();
  const threadId = randomUUID();
  const cwd = join(root, 'state', threadId, 'workspace');
  await mkdir(join(cwd, '.pi', 'extensions'), { recursive: true });
  await mkdir(join(cwd, '.pi', 'skills', 'fixture'), { recursive: true });
  await mkdir(join(cwd, '.pi', 'prompts'), { recursive: true });
  await writeFile(
    join(cwd, '.pi', 'skills', 'fixture', 'SKILL.md'),
    '---\nname: fixture\ndescription: DISCOVERY_MARKER\n---\nDISCOVERY_MARKER',
  );
  await writeFile(join(cwd, '.pi', 'prompts', 'fixture.md'), 'DISCOVERY_MARKER');
  await writeFile(join(cwd, 'AGENTS.md'), 'DISCOVERY_MARKER');
  await writeFile(
    join(cwd, '.pi', 'extensions', 'bad.ts'),
    "throw new Error('extension discovered')",
  );
  const session = await host.openSession({ threadId });
  onTestFinished(() => session.dispose());
  let enter!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const release = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let observed: TranscriptContext | undefined;
  faux.setResponses([
    async (context) => {
      observed = context;
      enter();
      await release;
      return fauxAssistantMessage('Finished');
    },
  ]);
  const run = await session.run({ content: [{ type: 'text', text: '/fixture' }] });
  const reader = run.events[Symbol.asyncIterator]();
  await reader.next();
  await entered;
  await reader.return?.();
  expect(faux.state.callCount).toBe(1);
  finish();
  expect((await run.result).status).toBe('completed');
  expect(observed).toBeDefined();
  expect(
    observed?.messages.flatMap((m) => (m.role === 'system' ? (m.toolsAdded ?? []) : [])),
  ).toEqual([]);
  expect(JSON.stringify(observed?.messages)).not.toContain('DISCOVERY_MARKER');
  expect(observed?.messages).toContainEqual(
    expect.objectContaining({ role: 'user', content: [{ type: 'text', text: '/fixture' }] }),
  );
});

it('preserves adapter rejection of file inputs before model invocation', async () => {
  const { host, faux } = await setup();
  const session = await host.openSession({ threadId: randomUUID() });
  onTestFinished(() => session.dispose());
  await expect(
    session.run({ content: [{ type: 'file', fileId: 'private-file' }] } as never),
  ).rejects.toThrow();
  expect(faux.state.callCount).toBe(0);
});
