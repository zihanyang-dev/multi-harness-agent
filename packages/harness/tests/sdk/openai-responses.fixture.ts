import './offline-guard.js';

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  AgentInputItem,
  ToolOutputFileContent,
  ToolOutputImage,
  ToolOutputText,
} from '@openai/agents';
import { Agent, OpenAIResponsesModel, Runner, RunState, tool } from '@openai/agents';
import OpenAI from 'openai';
import { z } from 'zod';

import { BLUE_IMAGE, PDF_DATA, RED_IMAGE } from '../fixtures/media.js';

const redImage = `data:image/png;base64,${RED_IMAGE}`;
const blueImage = `data:image/png;base64,${BLUE_IMAGE}`;
const pdf = `data:application/pdf;base64,${PDF_DATA}`;
const inputRequests: unknown[] = [];
const toolRequests: unknown[] = [];
let toolExecutions = 0;
const runner = new Runner({ tracingDisabled: true });

const orderedInput: AgentInputItem[] = [
  {
    role: 'user',
    content: [
      { type: 'input_text', text: 'A' },
      { type: 'input_image', image: redImage, detail: 'auto' },
      { type: 'input_text', text: 'B' },
      { type: 'input_image', image: blueImage, detail: 'auto' },
      { type: 'input_text', text: 'C' },
      { type: 'input_file', file: pdf, filename: 'tiny.pdf' },
      { type: 'input_text', text: 'D' },
    ],
  },
];

const inputAgent = new Agent({
  name: 'Offline input fixture',
  model: createResponsesModel(inputRequests),
});
const inputResult = await runner.run(inputAgent, orderedInput, { maxTurns: 2 });
const restoredInput = await RunState.fromString(inputAgent, inputResult.state.toString());

const multimodalTool = tool({
  name: 'multimodal_result',
  description: 'Return deterministic offline text, image, and file content.',
  parameters: z.object({}),
  execute: async (): Promise<(ToolOutputText | ToolOutputImage | ToolOutputFileContent)[]> => {
    toolExecutions += 1;
    return [
      { type: 'text', text: 'Tool text' },
      { type: 'image', image: blueImage, detail: 'auto' },
      {
        type: 'file',
        file: { data: PDF_DATA, mediaType: 'application/pdf', filename: 'tool.pdf' },
      },
    ];
  },
});
const toolResult = await runner.run(
  new Agent({
    name: 'Offline tool fixture',
    model: createResponsesModel(toolRequests, { invokeTool: true }),
    tools: [multimodalTool],
  }),
  [{ role: 'user', content: 'Call multimodal_result.' }],
  { maxTurns: 3 },
);

// Use the SDK serializer and rebind an agent, not a portable product-history checkpoint.
const stateFile = join(process.cwd(), 'openai-run.json');
await writeFile(stateFile, toolResult.state.toString());
const resumeRequests: unknown[] = [];
const resumedAgent = new Agent({
  name: 'Offline tool fixture',
  model: createResponsesModel(resumeRequests),
  tools: [multimodalTool],
});
const restoredTool = await RunState.fromString(resumedAgent, await readFile(stateFile, 'utf8'));
await runner.run(
  resumedAgent,
  [...restoredTool.history, { role: 'user', content: 'Resume check' }],
  { maxTurns: 2 },
);

// File references are not proof that Responses or a model accepts video/audio MIME types.
const referenceRequests: unknown[] = [];
const fileReferenceInput: AgentInputItem[] = [
  {
    role: 'user',
    content: [
      { type: 'input_text', text: 'A' },
      {
        type: 'input_file',
        file: { url: 'https://offline.invalid/reference.mp4' },
        filename: 'reference.mp4',
      },
      { type: 'input_text', text: 'B' },
      {
        type: 'input_file',
        file: { url: 'https://offline.invalid/reference.wav' },
        filename: 'reference.wav',
      },
      { type: 'input_text', text: 'C' },
    ],
  },
];
await runner.run(
  new Agent({ name: 'Offline reference fixture', model: createResponsesModel(referenceRequests) }),
  fileReferenceInput,
  { maxTurns: 2 },
);
const unsupportedAudioInput: AgentInputItem[] = [
  { role: 'user', content: [{ type: 'audio', audio: 'AA==', format: 'wav' }] },
];
const audioRequests: unknown[] = [];
let audioError = '';
try {
  await runner.run(
    new Agent({ name: 'Offline audio fixture', model: createResponsesModel(audioRequests) }),
    unsupportedAudioInput,
    { maxTurns: 2 },
  );
} catch (error) {
  audioError = error instanceof Error ? error.message : String(error);
}

// Keep provider requests and native SDK items intact; do not normalize their content.
console.log(
  JSON.stringify({
    inputRequests,
    inputHistory: inputResult.history,
    restoredInputHistory: restoredInput.history,
    restoredToolHistory: restoredTool.history,
    resumeRequests,
    referenceRequests,
    audioRequests,
    audioError,
    toolRequests,
    toolExecutions,
    toolItems: toolResult.newItems.map((item) => ({ type: item.type, rawItem: item.rawItem })),
    toolHistory: toolResult.history,
    rawResponses: toolResult.rawResponses,
    finalOutput: toolResult.finalOutput,
  }),
);

function createResponsesModel(
  requests: unknown[],
  { invokeTool = false }: { invokeTool?: boolean } = {},
): OpenAIResponsesModel {
  const finalMessage: OpenAI.Responses.ResponseOutputMessage = {
    type: 'message',
    id: 'msg_offline',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'Offline complete.', annotations: [] }],
  };
  const functionCall: OpenAI.Responses.ResponseFunctionToolCall = {
    type: 'function_call',
    id: 'fc_offline',
    call_id: 'call_offline',
    name: 'multimodal_result',
    arguments: '{}',
    status: 'completed',
  };

  const client = new OpenAI({
    apiKey: 'offline-placeholder-not-a-credential',
    baseURL: 'https://offline.invalid/v1',
    maxRetries: 0,
    fetch: async (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
      const request: unknown = JSON.parse(init.body);
      requests.push(request);
      if (requests.length > (invokeTool ? 2 : 1)) throw new Error('Unexpected extra model turn');
      const isToolCallTurn = invokeTool && requests.length === 1;
      const response: OpenAI.Responses.Response = {
        access_programs: null,
        output_text: isToolCallTurn ? '' : 'Offline complete.',
        id: `resp_offline_${requests.length}`,
        object: 'response',
        created_at: 0,
        status: 'completed',
        error: null,
        incomplete_details: null,
        instructions: null,
        model: 'gpt-4.1-mini',
        output: [isToolCallTurn ? functionCall : finalMessage],
        parallel_tool_calls: false,
        temperature: 1,
        tool_choice: 'auto',
        tools: [],
        top_p: 1,
        metadata: {},
        usage: {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 2,
        },
      };
      return Response.json(response);
    },
  });
  return new OpenAIResponsesModel(client, 'gpt-4.1-mini');
}
