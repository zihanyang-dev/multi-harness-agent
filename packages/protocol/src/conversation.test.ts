import { describe, expect, it } from 'vitest';
import { SubmitTurnSchema, ThreadSchema, TurnInputSchema, TurnSchema } from './index.js';

const id = '2fb67986-2782-4b2d-bdbb-bb397be5d744';
const threadId = '92f9362b-0675-493c-8b86-efc40b88854c';
const timestamp = '2026-10-11T12:00:00.000Z';
const input = { content: [{ type: 'text', text: 'Hello' }] };
const pending = {
  id,
  threadId,
  input,
  acceptedAt: timestamp,
  status: 'accepted',
  result: null,
  failureCode: null,
  finishedAt: null,
};
const result = { messages: [{ id: 'message-1', role: 'assistant', content: 'Hello back' }] };

// These cases catch normalization, widened input shapes, and missing admission limits.
describe('TurnInputSchema', () => {
  it('preserves ordered text and whitespace exactly', () => {
    const ordered = {
      content: [
        { type: 'text', text: '  First\n' },
        { type: 'text', text: '\t' },
        { type: 'text', text: 'Second  ' },
      ],
    };
    expect(TurnInputSchema.parse(ordered)).toEqual(ordered);
  });

  it('accepts 32 text parts and the 32000 UTF-16 character boundary', () => {
    const boundary = {
      content: Array.from({ length: 32 }, () => ({ type: 'text', text: '😀'.repeat(500) })),
    };
    expect(TurnInputSchema.parse(boundary)).toEqual(boundary);
  });

  it.each([
    ['no parts', { content: [] }],
    ['empty text', { content: [{ type: 'text', text: '' }] }],
    [
      'only whitespace',
      {
        content: [
          { type: 'text', text: ' \n' },
          { type: 'text', text: '\t' },
        ],
      },
    ],
    ['33 parts', { content: Array.from({ length: 33 }, () => ({ type: 'text', text: 'a' })) }],
    ['oversize text', { content: [{ type: 'text', text: 'a'.repeat(32001) }] }],
    [
      'oversize combined text',
      {
        content: [
          { type: 'text', text: 'a'.repeat(16000) },
          { type: 'text', text: 'b'.repeat(16001) },
        ],
      },
    ],
    ['oversize UTF-16 text', { content: [{ type: 'text', text: '😀'.repeat(16001) }] }],
    ['files', { content: [{ type: 'file', name: 'secret.txt', data: 'secret' }] }],
    ['unknown part fields', { content: [{ type: 'text', text: 'Hello', metadata: {} }] }],
    ['unknown input fields', { ...input, options: {} }],
  ])('rejects %s', (_name, value) => {
    expect(TurnInputSchema.safeParse(value).success).toBe(false);
  });
});

describe('SubmitTurnSchema', () => {
  it('accepts a caller request identity and preserves input', () => {
    const submission = { requestId: id, input };
    expect(SubmitTurnSchema.parse(submission)).toEqual(submission);
  });

  it.each([
    ['invalid request identity', { requestId: 'request-1', input }],
    ['empty input', { requestId: id, input: { content: [] } }],
    ['caller owner', { requestId: id, input, ownerId: id }],
    ['execution options', { requestId: id, input, options: {} }],
    ['control intent', { requestId: id, input, cancelRequested: true }],
  ])('rejects %s', (_name, value) => {
    expect(SubmitTurnSchema.safeParse(value).success).toBe(false);
  });
});

describe('ThreadSchema', () => {
  const thread = { id: threadId, harness: 'pi', createdAt: timestamp };

  it('accepts a public Pi thread', () => {
    expect(ThreadSchema.parse(thread)).toEqual(thread);
  });

  it.each([
    ['invalid identity', { ...thread, id: 'thread-1' }],
    ['unsupported harness', { ...thread, harness: 'claude' }],
    ['invalid timestamp', { ...thread, createdAt: 'yesterday' }],
    ['owner identity', { ...thread, ownerId: id }],
    ['native session path', { ...thread, sessionPath: '/private/session' }],
    ['native metadata', { ...thread, nativeMetadata: {} }],
  ])('rejects %s', (_name, value) => {
    expect(ThreadSchema.safeParse(value).success).toBe(false);
  });
});

// These cases catch status branches that accept contradictory lifecycle facts or private DTO fields.
describe('TurnSchema', () => {
  it.each(['accepted', 'running'])('accepts a %s turn without a settled outcome', (status) => {
    const turn = { ...pending, status };
    expect(TurnSchema.parse(turn)).toEqual(turn);
  });

  it.each([
    'binding_mismatch',
    'execution_unknown',
    'cleanup_failed',
    'result_commit_unknown',
    'unsupported_pause',
  ])('accepts unresolved %s without releasing the turn', (failureCode) => {
    const turn = { ...pending, status: 'needs_reconciliation', failureCode };
    expect(TurnSchema.parse(turn)).toEqual(turn);
  });

  it.each(['completed', 'cancelled'])('accepts %s with official display messages', (status) => {
    const turn = { ...pending, status, result, finishedAt: timestamp };
    expect(TurnSchema.parse(turn)).toEqual(turn);
  });

  it('accepts an execution failure without exposing diagnostics', () => {
    const turn = {
      ...pending,
      status: 'failed',
      failureCode: 'execution_failed',
      finishedAt: timestamp,
    };
    expect(TurnSchema.parse(turn)).toEqual(turn);
  });

  it.each([
    ['pending result', { ...pending, result }],
    ['pending failure', { ...pending, failureCode: 'execution_failed' }],
    ['pending finish', { ...pending, finishedAt: timestamp }],
    ['running result', { ...pending, status: 'running', result }],
    ['unresolved missing failure', { ...pending, status: 'needs_reconciliation' }],
    [
      'unresolved execution failure',
      { ...pending, status: 'needs_reconciliation', failureCode: 'execution_failed' },
    ],
    [
      'unresolved finish',
      {
        ...pending,
        status: 'needs_reconciliation',
        failureCode: 'execution_unknown',
        finishedAt: timestamp,
      },
    ],
    [
      'unresolved result',
      { ...pending, status: 'needs_reconciliation', failureCode: 'execution_unknown', result },
    ],
    ['completed missing result', { ...pending, status: 'completed', finishedAt: timestamp }],
    ['completed missing finish', { ...pending, status: 'completed', result }],
    ['cancelled missing result', { ...pending, status: 'cancelled', finishedAt: timestamp }],
    [
      'settled failure code',
      {
        ...pending,
        status: 'completed',
        result,
        finishedAt: timestamp,
        failureCode: 'execution_failed',
      },
    ],
    ['failed missing code', { ...pending, status: 'failed', finishedAt: timestamp }],
    ['failed missing finish', { ...pending, status: 'failed', failureCode: 'execution_failed' }],
    [
      'failed result',
      {
        ...pending,
        status: 'failed',
        failureCode: 'execution_failed',
        finishedAt: timestamp,
        result,
      },
    ],
    ['unknown status', { ...pending, status: 'paused' }],
    ['invalid turn identity', { ...pending, id: 'turn-1' }],
    ['invalid thread identity', { ...pending, threadId: 'thread-1' }],
    ['invalid acceptance timestamp', { ...pending, acceptedAt: 'yesterday' }],
    [
      'invalid finish timestamp',
      { ...pending, status: 'completed', result, finishedAt: 'yesterday' },
    ],
    ['invalid input', { ...pending, input: { content: [] } }],
    [
      'invalid display message',
      {
        ...pending,
        status: 'completed',
        result: { messages: [{ role: 'unknown' }] },
        finishedAt: timestamp,
      },
    ],
    [
      'private result fields',
      {
        ...pending,
        status: 'completed',
        result: { ...result, nativeMetadata: {} },
        finishedAt: timestamp,
      },
    ],
  ])('rejects %s', (_name, value) => {
    expect(TurnSchema.safeParse(value).success).toBe(false);
  });

  it.each(['ownerId', 'sessionPath', 'nativeMetadata', 'options', 'cancelRequested'])(
    'rejects private %s in every status branch',
    (field) => {
      const turns = [
        pending,
        { ...pending, status: 'running' },
        { ...pending, status: 'needs_reconciliation', failureCode: 'execution_unknown' },
        { ...pending, status: 'completed', result, finishedAt: timestamp },
        { ...pending, status: 'cancelled', result, finishedAt: timestamp },
        { ...pending, status: 'failed', failureCode: 'execution_failed', finishedAt: timestamp },
      ];
      for (const turn of turns) {
        expect(TurnSchema.safeParse({ ...turn, [field]: 'private' }).success).toBe(false);
      }
    },
  );
});
