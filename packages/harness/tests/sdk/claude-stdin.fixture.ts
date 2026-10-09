import './offline-guard.js';

import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import type { SDKUserMessage, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { BLUE_IMAGE, PDF_DATA, RED_IMAGE } from '../fixtures/media.js';

async function runStdinFixture(): Promise<void> {
  const child = new FixtureProcess();
  let spawnCount = 0;
  const session = query({
    prompt: interleavedInput(),
    options: {
      pathToClaudeCodeExecutable: '/offline-fixture/claude-not-executed',
      settingSources: [],
      tools: [],
      skills: [],
      mcpServers: {},
      strictMcpConfig: true,
      permissionMode: 'default',
      persistSession: false,
      env: {
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        CLAUDE_AGENT_SDK_DISABLE_MCP_MANIFESTS: '1',
      },
      spawnClaudeCodeProcess: () => {
        if (++spawnCount !== 1) throw new Error('Unexpected extra fixture spawn');
        return child;
      },
    },
  });
  let initialized = false;
  try {
    await session.initializationResult();
    initialized = true;
    for await (const _message of session) {
      throw new Error('Transport fixture must not emit model messages');
    }
  } finally {
    await session[Symbol.asyncDispose]();
    child.dispose();
  }
  console.log(
    JSON.stringify({
      stage: 'sdk-stdin',
      transport: 'in-memory-fixture-not-native-cli',
      messages: child.messages,
      initialized,
      initializeRequests: child.initializeRequests,
      spawnCount,
      syntheticResults: false,
      // This is fixture teardown, not an assertion about native SDK leak freedom.
      fixtureCleanup: {
        stdinDestroyed: child.stdin.destroyed,
        stdoutDestroyed: child.stdout.destroyed,
        processListenerCount: listenerCount(child),
        streamListenerCount: listenerCount(child.stdin) + listenerCount(child.stdout),
      },
    }),
  );
}

const frameSchema = z.object({ type: z.string() }).passthrough();
const initializeSchema = z
  .object({
    type: z.literal('control_request'),
    request_id: z.string(),
    request: z.object({ subtype: z.literal('initialize') }).passthrough(),
  })
  .passthrough();

// Only a newline-delimited transport fixture. No CLI, AgentLoop, model,
// history, tool handling, or synthetic model result is involved.
class FixtureProcess extends EventEmitter implements SpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stdin: Writable;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly messages: unknown[] = [];
  initializeRequests = 0;
  private pending = '';

  constructor() {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        try {
          this.pending += chunk.toString('utf8');
          let newline = this.pending.indexOf('\n');
          while (newline !== -1) {
            const raw: unknown = JSON.parse(this.pending.slice(0, newline));
            this.pending = this.pending.slice(newline + 1);
            const frame = frameSchema.parse(raw);
            if (frame.type === 'control_request') {
              const initialize = initializeSchema.parse(raw);
              this.initializeRequests++;
              this.stdout.write(
                `${JSON.stringify({
                  type: 'control_response',
                  response: {
                    subtype: 'success',
                    request_id: initialize.request_id,
                    response: { commands: [], models: [], agents: [] },
                  },
                })}\n`,
              );
            } else if (frame.type === 'user') {
              // Capture the parsed original stdin JSON, not a reconstructed payload.
              this.messages.push(raw);
            } else {
              throw new Error(`Unexpected SDK stdin frame: ${frame.type}`);
            }
            newline = this.pending.indexOf('\n');
          }
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
      final: (callback) => {
        if (this.pending) {
          callback(new Error('SDK stdin ended with an incomplete JSON frame'));
          return;
        }
        callback();
        queueMicrotask(() => this.finish());
      },
    });
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killed = true;
    this.finish(signal);
    return true;
  }

  dispose(): void {
    this.finish();
    this.stdin.destroy();
    this.stdout.destroy();
    this.stdin.removeAllListeners();
    this.stdout.removeAllListeners();
    this.removeAllListeners();
  }

  private finish(signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = signal ? null : 0;
    this.signalCode = signal;
    this.stdout.end();
    this.emit('exit', this.exitCode, signal);
  }
}

async function* interleavedInput(): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    parent_tool_use_id: null,
    session_id: '',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'A' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_IMAGE } },
        { type: 'text', text: 'B' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BLUE_IMAGE } },
        { type: 'text', text: 'C' },
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: PDF_DATA },
        },
        { type: 'text', text: 'D' },
      ],
    },
  };
}

const listenerCount = (emitter: EventEmitter): number =>
  emitter.eventNames().reduce((count, name) => count + emitter.listenerCount(name), 0);

await runStdinFixture();
