import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { BLUE_IMAGE, PDF_DATA, RED_IMAGE } from '../fixtures/media.js';
import { runSdkFixture } from './run-sdk-fixture.js';

const toolContent = [
  { type: 'input_text', text: 'Tool text' },
  { type: 'input_image', image_url: `data:image/png;base64,${BLUE_IMAGE}`, detail: 'auto' },
  {
    type: 'input_file',
    file_data: `data:application/pdf;base64,${PDF_DATA}`,
    filename: 'tool.pdf',
  },
];

const nativeToolContent = [
  { type: 'input_text', text: 'Tool text' },
  { type: 'input_image', image: `data:image/png;base64,${BLUE_IMAGE}`, detail: 'auto' },
  {
    type: 'input_file',
    file: `data:application/pdf;base64,${PDF_DATA}`,
    filename: 'tool.pdf',
  },
];

const orderedResponsesContent = [
  { type: 'input_text', text: 'A' },
  { type: 'input_image', image_url: `data:image/png;base64,${RED_IMAGE}`, detail: 'auto' },
  { type: 'input_text', text: 'B' },
  { type: 'input_image', image_url: `data:image/png;base64,${BLUE_IMAGE}`, detail: 'auto' },
  { type: 'input_text', text: 'C' },
  {
    type: 'input_file',
    file_data: `data:application/pdf;base64,${PDF_DATA}`,
    filename: 'tiny.pdf',
  },
  { type: 'input_text', text: 'D' },
];

const orderedNativeContent = [
  { type: 'input_text', text: 'A' },
  { type: 'input_image', image: `data:image/png;base64,${RED_IMAGE}`, detail: 'auto' },
  { type: 'input_text', text: 'B' },
  { type: 'input_image', image: `data:image/png;base64,${BLUE_IMAGE}`, detail: 'auto' },
  { type: 'input_text', text: 'C' },
  {
    type: 'input_file',
    file: `data:application/pdf;base64,${PDF_DATA}`,
    filename: 'tiny.pdf',
  },
  { type: 'input_text', text: 'D' },
];

const fileReferenceContent = [
  { type: 'input_text', text: 'A' },
  {
    type: 'input_file',
    file_url: 'https://offline.invalid/reference.mp4',
    filename: 'reference.mp4',
  },
  { type: 'input_text', text: 'B' },
  {
    type: 'input_file',
    file_url: 'https://offline.invalid/reference.wav',
    filename: 'reference.wav',
  },
  { type: 'input_text', text: 'C' },
];

describe('OpenAI native SDK offline multimodal behavior', () => {
  let report: z.infer<typeof reportSchema>;

  beforeAll(async () => {
    const parsed: unknown = JSON.parse(await runSdkFixture('openai'));
    report = reportSchema.parse(parsed);
  }, 30_000);

  it('preserves interleaved text, image, and PDF order in the real Responses request', () => {
    expect(report.inputRequests).toHaveLength(1);
    expect(report.inputRequests[0]?.input).toEqual([
      expect.objectContaining({
        role: 'user',
        content: orderedResponsesContent,
      }),
    ]);
  });

  it('round-trips ordered input and tool media through native RunState serialization', () => {
    expect(report.inputHistory).toEqual([
      expect.objectContaining({
        role: 'user',
        content: orderedNativeContent,
      }),
      expect.objectContaining({ role: 'assistant' }),
    ]);
    expect(report.restoredInputHistory).toEqual(report.inputHistory);
    expect(report.restoredToolHistory).toEqual(report.toolHistory);
    expect(report.resumeRequests).toHaveLength(1);
    const previousTurnInput = z.array(z.unknown()).parse(report.toolRequests[1]?.input);
    expect(report.resumeRequests[0]?.input).toEqual([
      ...previousTurnInput,
      expect.objectContaining({ role: 'assistant' }),
      expect.objectContaining({ role: 'user', content: 'Resume check' }),
    ]);
  });

  it('preserves video and audio file references without proving native media acceptance', () => {
    expect(report.referenceRequests).toHaveLength(1);
    expect(report.referenceRequests[0]?.input).toEqual([
      expect.objectContaining({
        role: 'user',
        content: fileReferenceContent,
      }),
    ]);
  });

  it('rejects the core audio content type before the Responses transport is called', () => {
    expect(report.audioRequests).toHaveLength(0);
    expect(report.audioError).toContain('Unsupported input content type:');
    expect(report.audioError).toContain('"type":"audio"');
  });

  it('executes the real tool and retains structured output inside the next function result', () => {
    expect(report.toolExecutions).toBe(1);
    expect(report.toolRequests).toHaveLength(2);
    expect(report.toolRequests[0]?.tools).toEqual([
      expect.objectContaining({ type: 'function', name: 'multimodal_result' }),
    ]);
    // Exact array cardinality also detects synthetic user messages or split tool media.
    expect(report.toolRequests[1]?.input).toEqual([
      expect.objectContaining({ role: 'user', content: 'Call multimodal_result.' }),
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_offline',
        name: 'multimodal_result',
        arguments: '{}',
      }),
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call_offline',
        output: toolContent,
      }),
    ]);
    expect(report.finalOutput).toBe('Offline complete.');
  });

  it('records native run items and model history without replacing them with normalized content', () => {
    const nativeResult = expect.objectContaining({
      type: 'function_call_result',
      callId: 'call_offline',
      name: 'multimodal_result',
      output: nativeToolContent,
    });
    expect(report.toolItems).toEqual([
      expect.objectContaining({ type: 'tool_call_item' }),
      expect.objectContaining({ type: 'tool_call_output_item', rawItem: nativeResult }),
      expect.objectContaining({ type: 'message_output_item' }),
    ]);
    expect(report.toolHistory).toEqual([
      expect.objectContaining({ role: 'user' }),
      expect.objectContaining({ type: 'function_call', callId: 'call_offline' }),
      nativeResult,
      expect.objectContaining({ role: 'assistant' }),
    ]);
    expect(report.rawResponses).toEqual([
      expect.objectContaining({
        providerData: expect.objectContaining({
          output: [expect.objectContaining({ type: 'function_call' })],
        }),
      }),
      expect.objectContaining({
        providerData: expect.objectContaining({
          output: [expect.objectContaining({ type: 'message' })],
        }),
      }),
    ]);
  });
});

const reportSchema = z.object({
  inputRequests: z.array(z.record(z.string(), z.unknown())),
  inputHistory: z.array(z.unknown()),
  restoredInputHistory: z.array(z.unknown()),
  restoredToolHistory: z.array(z.unknown()),
  resumeRequests: z.array(z.record(z.string(), z.unknown())),
  referenceRequests: z.array(z.record(z.string(), z.unknown())),
  audioRequests: z.array(z.unknown()),
  audioError: z.string(),
  toolRequests: z.array(z.record(z.string(), z.unknown())),
  toolExecutions: z.number(),
  toolItems: z.array(z.unknown()),
  toolHistory: z.array(z.unknown()),
  rawResponses: z.array(z.unknown()),
  finalOutput: z.unknown(),
});
