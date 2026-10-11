/** Native AgentSDK boundary fixture: only the clean launcher may import the SDK graph. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

it('commits native text results and resumes exact native context after a fresh worker and host', async () => {
  if (
    process.env.MHA_RUNTIME_FIXTURE !== '1' ||
    process.env.PI_OFFLINE !== '1' ||
    !process.env.PI_CODING_AGENT_DIR
  )
    throw new Error('Native runtime SDK tests require the isolated launcher');

  // Install before any SDK/provider imports. PostgreSQL and Redis use TCP, not HTTP.
  let networkAttempts = 0;
  const forbidHttp = () => {
    networkAttempts++;
    throw new Error('HTTP model network is forbidden in the native runtime fixture');
  };
  vi.stubGlobal('fetch', forbidHttp);
  vi.spyOn(http, 'request').mockImplementation(forbidHttp);
  vi.spyOn(http, 'get').mockImplementation(forbidHttp);
  vi.spyOn(https, 'request').mockImplementation(forbidHttp);
  vi.spyOn(https, 'get').mockImplementation(forbidHttp);
  syncBuiltinESMExports();
  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    syncBuiltinESMExports();
  });

  const { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } =
    await import('@earendil-works/pi-ai');
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const { acceptTurn } = await import('../../server/src/db/submissions.js');
  const { createThread } = await import('../../server/src/db/threads.js');
  const { reserveDeliveries } = await import('../../server/src/db/command-publication.js');
  const { default: pino } = await import('pino');
  const { createTestDatabase } = await import('../../../tests/integration/database.js');
  const { createTestQueue } = await import('../../../tests/integration/queue.js');
  const { createPiTurnHost } = await import('./harness/pi/host.js');
  const { publishDueTurns } = await import('../../server/src/conversation/command-publication.js');
  const { startWorker } = await import('./worker.js');

  const root = await mkdtemp(join(process.env.PI_CODING_AGENT_DIR, 'runtime-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const db = await createTestDatabase();
  onTestFinished(() => db.dispose());
  const redis = await createTestQueue();
  onTestFinished(() => redis.dispose());
  // Borrowed duplicate: runtime must not close the caller's queue/Redis/database.
  const connection = redis.connection.duplicate({ maxRetriesPerRequest: null });
  await connection.connect();
  onTestFinished(() => connection.disconnect());
  let runtime: ReturnType<typeof startWorker> | undefined;
  onTestFinished(async () => {
    await runtime?.close();
    await runtime?.finished;
  });

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
  const binding = {
    harness: 'pi' as const,
    sdkVersion: '1.1.0' as const,
    provider: model.provider,
    model: model.id,
    policy: 'text-v1' as const,
    storageId: 'test-native-volume',
  };
  const stateRoot = join(root, 'state');
  const thread = await createThread(db.database, { ownerId: 'alice', binding });
  const inputs = [
    {
      content: [
        { type: 'text' as const, text: 'First part\n' },
        { type: 'text' as const, text: 'Second part' },
      ],
    },
    {
      content: [
        { type: 'text' as const, text: 'Follow up\n' },
        { type: 'text' as const, text: 'In order' },
      ],
    },
  ];
  let resumedContextChecked = false;
  faux.setResponses([
    (context) => {
      expect(
        context.messages
          .filter((message) => message.role === 'user')
          .map((message) => message.content),
      ).toEqual([[{ type: 'text', text: 'First part\nSecond part' }]]);
      return fauxAssistantMessage('First native answer');
    },
    (context) => {
      // These messages came from native JSONL reopening, not public Turn.result_json.
      expect(
        context.messages
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .map((message) => ({ role: message.role, content: message.content })),
      ).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'First part\nSecond part' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'First native answer' }] },
        { role: 'user', content: [{ type: 'text', text: 'Follow up\nIn order' }] },
      ]);
      resumedContextChecked = true;
      return fauxAssistantMessage('Second native answer');
    },
  ]);

  let nativeSessionId: string | null = null;
  const turnIds: string[] = [];
  let nativeJoins = 0;
  for (const [index, input] of inputs.entries()) {
    const accepted = await acceptTurn(db.database, {
      ownerId: 'alice',
      threadId: thread.id,
      requestId: randomUUID(),
      input,
    });
    if (accepted.kind !== 'accepted') throw new Error('Expected accepted Turn');
    const turnId = accepted.turn.id;
    turnIds.push(turnId);
    const outbox = await db.database
      .selectFrom('turn_outbox')
      .selectAll()
      .where('turn_id', '=', turnId)
      .executeTakeFirstOrThrow();
    expect(outbox.last_published_at).toBeNull();
    expect(await redis.queue.getJob(`turn-${turnId}-0`)).toBeUndefined();
    await publishDueTurns(db.database, redis.queue);
    const job = await redis.queue.getJob(`turn-${turnId}-0`);
    expect(job?.data).toEqual({ turnId });
    expect(
      (
        await db.database
          .selectFrom('turn_outbox')
          .selectAll()
          .where('turn_id', '=', turnId)
          .executeTakeFirstOrThrow()
      ).last_published_at,
    ).not.toBeNull();

    // A fresh official host and BullMQ runtime per turn; no custom session implementation.
    const officialHost = createPiTurnHost({ binding, stateRoot, modelRuntime });
    const host = {
      binding: officialHost.binding,
      async openSession(request: Parameters<typeof officialHost.openSession>[0]) {
        const native = await officialHost.openSession(request);
        return {
          ...native,
          async dispose() {
            // Observe the real adapter's joined native cleanup, without replacing it.
            await native.dispose();
            nativeJoins++;
            const pending = await db.database
              .selectFrom('turn_attempts')
              .selectAll()
              .where('turn_id', '=', turnId)
              .executeTakeFirstOrThrow();
            expect(pending.stopped_at).toBeNull();
            expect(
              (
                await db.database
                  .selectFrom('turns')
                  .selectAll()
                  .where('id', '=', turnId)
                  .executeTakeFirstOrThrow()
              ).status,
            ).toBe('running');
          },
        };
      },
    };
    runtime = startWorker({
      database: db.database,
      prefix: redis.prefix,
      connection,
      host,
      maxRunMs: 10000,
      logger: pino({ level: 'silent' }),
    });
    await expect
      .poll(
        async () =>
          (
            await db.database
              .selectFrom('turns')
              .selectAll()
              .where('id', '=', turnId)
              .executeTakeFirstOrThrow()
          ).status,
        { timeout: 10000 },
      )
      .toBe('completed');
    await expect.poll(() => job?.getState()).toBe('completed');
    const turn = await db.database
      .selectFrom('turns')
      .selectAll()
      .where('id', '=', turnId)
      .executeTakeFirstOrThrow();
    expect(turn.result_json).toEqual({
      messages: [
        {
          id: expect.any(String),
          role: 'assistant',
          content: index === 0 ? 'First native answer' : 'Second native answer',
        },
      ],
    });
    expect(turn.finished_at).not.toBeNull();
    expect(turn.failure_code).toBeNull();
    const attempt = await db.database
      .selectFrom('turn_attempts')
      .selectAll()
      .where('turn_id', '=', turnId)
      .executeTakeFirstOrThrow();
    expect(attempt.stopped_at).not.toBeNull();
    expect(attempt.native_session_id).toEqual(expect.any(String));
    const saved = await db.database
      .selectFrom('threads')
      .selectAll()
      .where('id', '=', thread.id)
      .executeTakeFirstOrThrow();
    expect(saved.native_session_id).toBe(attempt.native_session_id);
    if (index === 0) nativeSessionId = saved.native_session_id;
    else expect(saved.native_session_id).toBe(nativeSessionId);
    await runtime.close();
    await runtime.finished;
    runtime = undefined;
    expect(await connection.ping()).toBe('PONG');
    expect(await redis.connection.ping()).toBe('PONG');
  }
  expect(resumedContextChecked).toBe(true);
  expect(nativeJoins).toBe(2);
  expect(faux.state.callCount).toBe(2);
  expect(networkAttempts).toBe(0);
  // Completed turns retain outbox telemetry but are no longer eligible for delivery.
  expect(await reserveDeliveries(db.database, { limit: 20, redeliveryDelayMs: 10000 })).toEqual([]);
  expect(
    await db.database
      .selectFrom('turn_attempts')
      .selectAll()
      .where('turn_id', 'in', turnIds)
      .execute(),
  ).toHaveLength(2);
  const sessionDir = join(stateRoot, thread.id, 'sessions');
  const files = (await readdir(sessionDir)).filter((file) => file.endsWith('.jsonl'));
  expect(files).toHaveLength(1);
  const entries = (await readFile(join(sessionDir, files[0] as string), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(entries[0]).toMatchObject({ type: 'session', id: nativeSessionId });
  expect(
    entries.filter((entry) => entry.type === 'message').map((entry) => entry.message.role),
  ).toEqual(['system', 'user', 'assistant', 'user', 'assistant']);
  const nativeAnswers = entries.filter(
    (entry) => entry.type === 'message' && entry.message.role === 'assistant',
  );
  for (const [index, turnId] of turnIds.entries()) {
    const turn = await db.database
      .selectFrom('turns')
      .select('result_json')
      .where('id', '=', turnId)
      .executeTakeFirstOrThrow();
    expect(turn.result_json).toEqual({
      messages: [
        {
          id: nativeAnswers[index].id,
          role: 'assistant',
          content: nativeAnswers[index].message.content[0].text,
        },
      ],
    });
  }
});
