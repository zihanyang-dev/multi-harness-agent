import { expect, it } from 'vitest';
import { captureSubmission, decideTurnReplay } from './submission.js';

const request = {
  ownerId: 'Alice',
  threadId: 'AABBCCDD-0000-4000-8000-000000000001',
  requestId: 'EEFFABCD-0000-4000-8000-000000000002',
  input: {
    content: [
      { type: 'text' as const, text: 'First ' },
      { type: 'text' as const, text: 'second' },
    ],
  },
};

it('captures ordered input and canonical UUID identity without changing opaque owners or text', () => {
  const input = structuredClone(request);
  const captured = captureSubmission(input);
  const first = input.input.content[0];
  if (first === undefined) throw new Error('Missing input fixture');
  first.text = 'changed';
  expect(captured).toEqual({
    ...request,
    threadId: request.threadId.toLowerCase(),
    requestId: request.requestId.toLowerCase(),
  });
});

it('replays matching input regardless of JSON object key order', () => {
  const submission = captureSubmission(request);
  expect(
    decideTurnReplay(submission, {
      threadId: request.threadId.toLowerCase(),
      input: {
        content: [
          { text: 'First ', type: 'text' },
          { text: 'second', type: 'text' },
        ],
      },
    }),
  ).toBe('replay');
});

it('distinguishes an unused identity from conflicting thread, order, text and segmentation', () => {
  const submission = captureSubmission(request);
  expect(decideTurnReplay(submission, undefined)).toBe('new');
  for (const existing of [
    { threadId: 'other', input: request.input },
    {
      threadId: request.threadId.toLowerCase(),
      input: { content: [...request.input.content].reverse() },
    },
    {
      threadId: request.threadId.toLowerCase(),
      input: { content: [{ type: 'text', text: 'First second' }] },
    },
    {
      threadId: request.threadId.toLowerCase(),
      input: { content: [{ type: 'text', text: 'First' }, request.input.content[1]] },
    },
  ])
    expect(decideTurnReplay(submission, existing)).toBe('conflict');
});
