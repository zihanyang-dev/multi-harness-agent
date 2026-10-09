import { execFileSync } from 'node:child_process';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { BaseEvent } from '@ag-ui/core';
import { EventType } from '@ag-ui/core';
import { Agent, OpenAIResponsesModel, Runner } from '@openai/agents';
import { describe, expect, it } from 'vitest';

import type { OpenAIClientFixture } from '../../tests/fixtures/openai-client.js';
import { createOpenAIClientFixture } from '../../tests/fixtures/openai-client.js';
import type { HarnessTurnResult } from '../contract.js';
import { createRunEvents, toMessages } from './output.js';

describe('OpenAI text output', () => {
  it('projects complete assistant messages in native order', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueue([
      {
        type: 'message',
        id: 'msg_first',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'First', annotations: [] }],
      },
      {
        type: 'message',
        id: 'msg_second',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Second', annotations: [] }],
      },
    ]);
    const run = await startRun(fixture);
    await run.completed;

    const messages = toMessages(run.newItems);

    expect(messages).toEqual([
      { id: 'msg_first', role: 'assistant', content: 'First' },
      { id: 'msg_second', role: 'assistant', content: 'Second' },
    ]);
  });

  it('does not copy reasoning or private provider data into text messages', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueue([
      {
        type: 'reasoning',
        id: 'rs_private',
        summary: [{ type: 'summary_text', text: 'Reasoning summary' }],
        encrypted_content: 'private-token',
      },
      {
        type: 'message',
        id: 'msg_public',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Public answer', annotations: [] }],
      },
    ]);
    const run = await startRun(fixture);
    await run.completed;

    const messages = toMessages(run.newItems);

    expect(messages).toEqual([{ id: 'msg_public', role: 'assistant', content: 'Public answer' }]);
  });

  it('streams text deltas once without replaying the complete message', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueue('Hello');
    const run = await startRun(fixture);
    const result = run.completed.then(completedResult);

    const events = await collectEvents(
      createRunEvents(run.toStream().values({ preventCancel: true }), {
        threadId: 'thread_1',
        runId: 'run_1',
        result,
      }),
    );

    expect(events).toEqual([
      { type: EventType.RUN_STARTED, threadId: 'thread_1', runId: 'run_1' },
      { type: EventType.TEXT_MESSAGE_START, messageId: 'msg_fixture_1', role: 'assistant' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'msg_fixture_1', delta: 'Hel' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'msg_fixture_1', delta: 'lo' },
      { type: EventType.TEXT_MESSAGE_END, messageId: 'msg_fixture_1' },
      {
        type: EventType.RUN_FINISHED,
        threadId: 'thread_1',
        runId: 'run_1',
        outcome: { type: 'success' },
      },
    ]);
  });

  it('emits complete text when the provider sends no text deltas', async () => {
    const fixture = createOpenAIClientFixture({ textDeltas: false });
    fixture.enqueue('Hello');
    const run = await startRun(fixture);
    const result = run.completed.then(completedResult);

    const events = await collectEvents(
      createRunEvents(run.toStream().values({ preventCancel: true }), {
        threadId: 'thread_1',
        runId: 'run_1',
        result,
      }),
    );

    expect(events).toEqual([
      { type: EventType.RUN_STARTED, threadId: 'thread_1', runId: 'run_1' },
      { type: EventType.TEXT_MESSAGE_START, messageId: 'msg_fixture_1', role: 'assistant' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'msg_fixture_1', delta: 'Hello' },
      { type: EventType.TEXT_MESSAGE_END, messageId: 'msg_fixture_1' },
      {
        type: EventType.RUN_FINISHED,
        threadId: 'thread_1',
        runId: 'run_1',
        outcome: { type: 'success' },
      },
    ]);
  });

  it('tracks overlapping native messages independently', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueue([
      {
        type: 'message',
        id: 'msg_first',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'First', annotations: [] }],
      },
      {
        type: 'message',
        id: 'msg_second',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Second', annotations: [] }],
      },
    ]);
    const run = await startRun(fixture);
    const result = run.completed.then(completedResult);

    const events = await collectEvents(
      createRunEvents(run.toStream().values({ preventCancel: true }), {
        threadId: 'thread_1',
        runId: 'run_1',
        result,
      }),
    );

    expect(events.filter((event) => event.type === EventType.TEXT_MESSAGE_START)).toEqual([
      { type: EventType.TEXT_MESSAGE_START, messageId: 'msg_first', role: 'assistant' },
      { type: EventType.TEXT_MESSAGE_START, messageId: 'msg_second', role: 'assistant' },
    ]);
    expect(
      events
        .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((event) => event.delta),
    ).toEqual(['Fir', 'st', 'Sec', 'ond']);
    expect(events.filter((event) => event.type === EventType.TEXT_MESSAGE_END)).toEqual([
      { type: EventType.TEXT_MESSAGE_END, messageId: 'msg_first' },
      { type: EventType.TEXT_MESSAGE_END, messageId: 'msg_second' },
    ]);
  });

  it('preserves an empty message without emitting an empty content delta', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueue('');
    const run = await startRun(fixture);
    const result = run.completed.then(completedResult);

    const events = await collectEvents(
      createRunEvents(run.toStream().values({ preventCancel: true }), {
        threadId: 'thread_1',
        runId: 'run_1',
        result,
      }),
    );

    expect(toMessages(run.newItems)).toEqual([
      { id: 'msg_fixture_1', role: 'assistant', content: '' },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
  });

  it('waits for the caller result after the native text stream ends', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueue('Hello');
    const run = await startRun(fixture);
    const result = Promise.withResolvers<HarnessTurnResult>();
    const events = createRunEvents(run.toStream().values({ preventCancel: true }), {
      threadId: 'thread_1',
      runId: 'run_1',
      result: result.promise,
    });
    const observer = events[Symbol.asyncIterator]();
    for (let index = 0; index < 5; index++) await observer.next();
    let finished = false;
    const terminal = observer.next();
    const observed = terminal.then(() => {
      finished = true;
    });

    await setImmediate();
    expect(finished).toBe(false);
    result.resolve(completedResult());

    expect((await terminal).value).toMatchObject({ type: EventType.RUN_FINISHED });
    await observed;
    await observer.return?.();
  });

  it('does not cancel an active native run when the observer stops reading', async () => {
    const release = Promise.withResolvers<void>();
    const fixture = createOpenAIClientFixture({ pauseAfterText: release.promise });
    fixture.enqueue('Hello');
    const run = await startRun(fixture);
    let settled = false;
    const settlement = run.completed.then(() => {
      settled = true;
    });
    const events = createRunEvents(run.toStream().values({ preventCancel: true }), {
      threadId: 'thread_1',
      runId: 'run_1',
      result: run.completed.then(completedResult),
    });
    const observer = events[Symbol.asyncIterator]();
    await observer.next();
    await observer.next();
    await observer.next();

    try {
      expect(settled).toBe(false);
      await observer.return?.();
      expect(run.cancelled).toBe(false);
    } finally {
      release.resolve();
    }
    await settlement;

    expect(run.cancelled).toBe(false);
    expect(toMessages(run.newItems)).toEqual([
      { id: 'msg_fixture_1', role: 'assistant', content: 'Hello' },
    ]);
  });

  it('uses a cancelled caller result instead of inferring success from text completion', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueue('Hello');
    const run = await startRun(fixture);
    const result = run.completed.then(
      (): HarnessTurnResult => ({ status: 'cancelled', messages: [] }),
    );

    const events = await collectEvents(
      createRunEvents(run.toStream().values({ preventCancel: true }), {
        threadId: 'thread_1',
        runId: 'run_1',
        result,
      }),
    );

    expect(events.at(-1)).toEqual({
      type: EventType.RUN_FINISHED,
      threadId: 'thread_1',
      runId: 'run_1',
      outcome: { type: 'cancelled' },
    });
  });

  it('reports a failed caller result after successfully receiving the text', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueue('Hello');
    const run = await startRun(fixture);
    const result = run.completed.then(() => {
      throw new Error('Private persistence failure');
    });
    const rejection = expect(result).rejects.toThrow(/Private persistence failure/);

    const events = await collectEvents(
      createRunEvents(run.toStream().values({ preventCancel: true }), {
        threadId: 'thread_1',
        runId: 'run_1',
        result,
      }),
    );
    await rejection;

    expect(events.at(-1)).toEqual({ type: EventType.RUN_ERROR, message: 'OpenAI run failed' });
    expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(false);
    expect(events).toContainEqual({ type: EventType.TEXT_MESSAGE_END, messageId: 'msg_fixture_1' });
  });

  it('observes a late result rejection after the observer unsubscribes', () => {
    // A child process exposes unhandled rejection failures without altering Vitest's listeners.
    const script = `
      import assert from 'node:assert/strict';
      import { setImmediate } from 'node:timers/promises';
      import { createRunEvents } from './src/openai/output.ts';

      const result = Promise.withResolvers();
      const source = (async function* () {})();
      const observer = createRunEvents(source, {
        threadId: 'thread_1', runId: 'run_1', result: result.promise,
      })[Symbol.asyncIterator]();
      await observer.next();
      await observer.return();
      result.reject(new Error('Late execution failure'));
      await setImmediate();
      await assert.rejects(result.promise, /Late execution failure/);
      console.log('observer-closed');
    `;

    const output = execFileSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', script],
      {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        env: {},
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    expect(output.trim()).toBe('observer-closed');
  });

  it('emits a sanitized run error while preserving the provider rejection', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueueError(503, 'Private provider diagnostic');
    const run = await startRun(fixture);
    const result = run.completed.then(completedResult);
    const rejection = expect(result).rejects.toThrow(/Private provider diagnostic/);

    const events = await collectEvents(
      createRunEvents(run.toStream().values({ preventCancel: true }), {
        threadId: 'thread_1',
        runId: 'run_1',
        result,
      }),
    );
    await rejection;

    expect(events).toEqual([
      { type: EventType.RUN_STARTED, threadId: 'thread_1', runId: 'run_1' },
      { type: EventType.RUN_ERROR, message: 'OpenAI run failed' },
    ]);
  });
});

async function startRun(fixture: OpenAIClientFixture) {
  const agent = new Agent({
    name: 'Text fixture',
    model: new OpenAIResponsesModel(fixture.client, 'gpt-4.1'),
  });
  const runner = new Runner({ tracingDisabled: true });
  return runner.run(agent, 'Reply with the scripted text.', { stream: true });
}

function completedResult(): HarnessTurnResult {
  return { status: 'completed', messages: [] };
}

async function collectEvents(source: AsyncIterable<BaseEvent>): Promise<BaseEvent[]> {
  const events: BaseEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}
