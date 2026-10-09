import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { BLUE_IMAGE, PDF_DATA, RED_IMAGE } from '../fixtures/media.js';
import { runSdkFixture } from './run-sdk-fixture.js';

const interleavedContent = [
  { type: 'text', text: 'A' },
  {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: RED_IMAGE },
  },
  { type: 'text', text: 'B' },
  {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: BLUE_IMAGE },
  },
  { type: 'text', text: 'C' },
  {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: PDF_DATA },
  },
  { type: 'text', text: 'D' },
];

describe('Claude Agent SDK offline input transport', () => {
  it('writes ordered multimodal blocks through public query to SDK stdin', async () => {
    const raw: unknown = JSON.parse(await runSdkFixture('claude'));
    const report = reportSchema.parse(raw);
    expect(report.messages).toHaveLength(1);
    const content = report.messages[0]?.message.content;
    expect(content).toMatchObject(interleavedContent);
  }, 15_000);
});

const source = z
  .object({
    type: z.literal('base64'),
    media_type: z.string(),
    data: z.string(),
  })
  .passthrough();
const block = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).passthrough(),
  z.object({ type: z.literal('image'), source }).passthrough(),
  z.object({ type: z.literal('document'), source }).passthrough(),
]);
const reportSchema = z
  .object({
    stage: z.literal('sdk-stdin'),
    transport: z.literal('in-memory-fixture-not-native-cli'),
    messages: z.array(
      z
        .object({
          type: z.literal('user'),
          message: z.object({ role: z.literal('user'), content: z.array(block) }).passthrough(),
        })
        .passthrough(),
    ),
    initialized: z.literal(true),
    initializeRequests: z.literal(1),
    spawnCount: z.literal(1),
    syntheticResults: z.literal(false),
    fixtureCleanup: z.object({
      stdinDestroyed: z.literal(true),
      stdoutDestroyed: z.literal(true),
      processListenerCount: z.literal(0),
      streamListenerCount: z.literal(0),
    }),
  })
  .passthrough();
