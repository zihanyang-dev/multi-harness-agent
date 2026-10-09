import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { BLUE_IMAGE, RED_IMAGE } from '../fixtures/media.js';
import { runSdkFixture } from './run-sdk-fixture.js';

const normalizedInput = [
  { type: 'text', text: 'Text A\nText B\nText C' },
  { type: 'image', data: RED_IMAGE, mimeType: 'image/png' },
  { type: 'image', data: BLUE_IMAGE, mimeType: 'image/png' },
];
const toolContent = [
  { type: 'text', text: 'Tool text' },
  { type: 'image', data: BLUE_IMAGE, mimeType: 'image/png' },
];

describe('Pi multimodal SDK characterization', () => {
  let report: z.infer<typeof reportSchema>;

  beforeAll(async () => {
    const parsed: unknown = JSON.parse(await runSdkFixture('pi'));
    report = reportSchema.parse(parsed);
  }, 30_000);

  it('groups text before images in the public sendUserMessage path', () => {
    expect(report.input.map((part) => part.type)).toEqual([
      'text',
      'image',
      'text',
      'image',
      'text',
    ]);
    expect(report.contexts).toHaveLength(3);
    expect(report.contexts[0]?.messages.find((item) => item.role === 'user')?.content).toEqual(
      normalizedInput,
    );
  });

  it('persists the normalized order rather than the original interleaving', () => {
    expect(report.sessionMessages.find((item) => item.role === 'user')?.content).toEqual(
      normalizedInput,
    );
    const messages = readPersistedMessages(report.sessionJsonl);
    expect(messages.find((item) => item.role === 'user')?.content).toEqual(normalizedInput);
    expect(messages.find((item) => item.role === 'toolResult')?.content).toEqual(toolContent);
  });

  it('carries a real tool image result into the next provider context and restored session', () => {
    expect(report.toolExecutions).toBe(1);
    expect(
      report.contexts[1]?.messages.find((item) => item.role === 'toolResult')?.content,
    ).toEqual(toolContent);
    expect(report.restoredMessages).toEqual(report.sessionMessages);
    expect(report.contexts[2]?.messages.find((item) => item.role === 'user')?.content).toEqual(
      normalizedInput,
    );
    expect(
      report.contexts[2]?.messages.find((item) => item.role === 'toolResult')?.content,
    ).toEqual(toolContent);
  });
});

function readPersistedMessages(jsonl: string): z.infer<typeof message>[] {
  const messages: z.infer<typeof message>[] = [];
  for (const line of jsonl.trim().split('\n')) {
    const raw: unknown = JSON.parse(line);
    const entry = entrySchema.parse(raw);
    if (entry.type === 'message' && entry.message) messages.push(entry.message);
  }
  return messages;
}

const block = z.looseObject({ type: z.string() });
const message = z.looseObject({ role: z.string(), content: z.union([z.string(), z.array(block)]) });
const reportSchema = z.object({
  stage: z.literal('sdk-provider-context-and-native-jsonl'),
  input: z.array(block),
  contexts: z.array(z.object({ messages: z.array(message) })),
  sessionMessages: z.array(message),
  restoredMessages: z.array(message),
  sessionJsonl: z.string(),
  toolExecutions: z.number(),
});

const entrySchema = z.looseObject({ type: z.string(), message: message.optional() });
