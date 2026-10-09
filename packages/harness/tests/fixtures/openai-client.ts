import OpenAI from 'openai';
import { z } from 'zod';

export interface OpenAIClientRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

export interface OpenAIClientFixture {
  client: OpenAI;
  requests: OpenAIClientRequest[];
  enqueue: (...outputs: (string | OpenAI.Responses.ResponseOutputItem[])[]) => void;
  enqueueError: (status: number, message?: string) => void;
}

type ScriptedResponse =
  | { output: string | OpenAI.Responses.ResponseOutputItem[] }
  | { status: number; message: string };

const recordSchema = z.record(z.string(), z.unknown());
const itemsSchema = z.array(recordSchema);

/**
 * Runs the real OpenAI client against an in-memory HTTP boundary.
 *
 * Responses must be scripted once per model call. No sockets, credentials, or
 * cleanup are needed; captured bodies retain native tool and multimodal payloads.
 */
export function createOpenAIClientFixture(
  options: { textDeltas?: boolean; pauseAfterText?: Promise<void> } = {},
): OpenAIClientFixture {
  const requests: OpenAIClientRequest[] = [];
  const scripts: ScriptedResponse[] = [];
  const conversations = new Map<string, Record<string, unknown>[]>();
  let conversationSequence = 0;
  let responseSequence = 0;
  let itemSequence = 0;

  function appendItems(conversationId: string, input: unknown) {
    const history = conversations.get(conversationId);
    if (!history) throw new Error(`Unknown fixture conversation: ${conversationId}`);
    const items = itemsSchema.parse(input).map((item) => {
      const normalized: Record<string, unknown> = {
        ...item,
        id: typeof item.id === 'string' ? item.id : `item_fixture_${++itemSequence}`,
        status: typeof item.status === 'string' ? item.status : 'completed',
      };
      if (normalized.type === 'message' && typeof normalized.content === 'string') {
        normalized.content = [{ type: 'input_text', text: normalized.content }];
      }
      return normalized;
    });
    history.push(...items);
    return items;
  }

  const client = new OpenAI({
    apiKey: 'fixture-placeholder-key',
    baseURL: 'https://openai-fixture.invalid',
    maxRetries: 0,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const text = await request.text();
      const body = text ? recordSchema.parse(JSON.parse(text)) : undefined;
      requests.push({ method: request.method, path: url.pathname, body });

      if (request.method === 'POST' && url.pathname === '/responses') {
        const script = scripts.shift();
        if (!script) throw new Error('No scripted OpenAI response remains');
        if ('status' in script) {
          return jsonResponse(
            { error: { message: script.message, type: 'fixture_error' } },
            script.status,
          );
        }
        const responseId = `resp_fixture_${++responseSequence}`;
        const output =
          typeof script.output === 'string'
            ? [textOutput(`msg_fixture_${responseSequence}`, script.output)]
            : structuredClone(script.output);
        const response = completedResponse(responseId, output, body?.model);
        return body?.stream === true
          ? streamResponse(response, options.textDeltas ?? true, options.pauseAfterText)
          : jsonResponse(response);
      }

      if (request.method === 'POST' && url.pathname === '/conversations') {
        const id = `conv_fixture_${++conversationSequence}`;
        conversations.set(id, []);
        appendItems(id, body?.items ?? []);
        return jsonResponse({ id, object: 'conversation', created_at: 1, metadata: null });
      }

      const match = /^\/conversations\/([^/]+)(?:\/items(?:\/([^/]+))?)?$/.exec(url.pathname);
      const conversationId = match?.[1];
      const history = conversationId ? conversations.get(conversationId) : undefined;
      if (!conversationId || !history) {
        throw new Error(`Unexpected fixture request: ${request.method} ${url.pathname}`);
      }
      if (request.method === 'DELETE') {
        const itemId = match?.[2];
        if (itemId) {
          const index = history.findIndex((item) => item.id === itemId);
          if (index < 0) throw new Error(`Unknown fixture item: ${itemId}`);
          history.splice(index, 1);
          return jsonResponse({ id: itemId, object: 'conversation.item.deleted', deleted: true });
        }
        conversations.delete(conversationId);
        return jsonResponse({ id: conversationId, object: 'conversation.deleted', deleted: true });
      }
      if (url.pathname.endsWith('/items')) {
        if (request.method === 'POST') {
          return jsonResponse(itemPage(appendItems(conversationId, body?.items), false));
        }
        if (request.method === 'GET') {
          const ordered =
            url.searchParams.get('order') === 'desc' ? [...history].reverse() : history;
          const after = url.searchParams.get('after');
          const start = after ? ordered.findIndex((item) => item.id === after) + 1 : 0;
          const limit = Number(url.searchParams.get('limit') ?? 100);
          const data = ordered.slice(start, start + limit);
          return jsonResponse(itemPage(data, start + data.length < ordered.length));
        }
      }
      throw new Error(`Unexpected fixture request: ${request.method} ${url.pathname}`);
    },
  });

  return {
    client,
    requests,
    enqueue: (...outputs) => scripts.push(...outputs.map((output) => ({ output }))),
    enqueueError: (status, message = 'Scripted OpenAI failure') =>
      scripts.push({ status, message }),
  };
}

function textOutput(id: string, text: string): OpenAI.Responses.ResponseOutputMessage {
  return {
    id,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
  };
}

function completedResponse(
  id: string,
  output: OpenAI.Responses.ResponseOutputItem[],
  model: unknown,
): OpenAI.Responses.Response {
  return {
    id,
    object: 'response',
    created_at: 1,
    completed_at: 1,
    status: 'completed',
    access_programs: null,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    model: typeof model === 'string' ? model : 'gpt-4.1',
    output,
    output_text: output
      .flatMap((item) =>
        item.type === 'message'
          ? item.content.flatMap((part) => (part.type === 'output_text' ? [part.text] : []))
          : [],
      )
      .join(''),
    parallel_tool_calls: true,
    temperature: 1,
    top_p: 1,
    tool_choice: 'auto',
    tools: [],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

function streamResponse(
  response: OpenAI.Responses.Response,
  textDeltas: boolean,
  pauseAfterText: Promise<void> | undefined,
): Response {
  const events: OpenAI.Responses.ResponseStreamEvent[] = [];
  const push = (event: OpenAI.Responses.ResponseStreamEvent) => events.push(event);
  push({
    type: 'response.created',
    sequence_number: events.length,
    response: {
      ...response,
      status: 'in_progress',
      completed_at: null,
      output: [],
      output_text: '',
    },
  });
  response.output.forEach((item, outputIndex) => {
    push({
      type: 'response.output_item.added',
      sequence_number: events.length,
      output_index: outputIndex,
      item,
    });
    if (item.type === 'message' && textDeltas) {
      item.content.forEach((part, contentIndex) => {
        if (part.type !== 'output_text') return;
        const midpoint = Math.ceil(part.text.length / 2);
        const deltas = [part.text.slice(0, midpoint), part.text.slice(midpoint)];
        for (const delta of deltas) {
          if (!delta) continue;
          push({
            type: 'response.output_text.delta',
            sequence_number: events.length,
            item_id: item.id,
            output_index: outputIndex,
            content_index: contentIndex,
            delta,
            logprobs: [],
          });
        }
      });
    }
    push({
      type: 'response.output_item.done',
      sequence_number: events.length,
      output_index: outputIndex,
      item,
    });
  });
  push({ type: 'response.completed', sequence_number: events.length, response });
  const frames = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const headers = { 'content-type': 'text/event-stream' };
  if (!pauseAfterText) return new Response(`${frames.join('')}data: [DONE]\n\n`, { headers });

  // Hold the actual HTTP body after a text delta, before native completion is available.
  const split = events.findIndex((event) => event.type === 'response.output_text.delta') + 1;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(frames.slice(0, split).join('')));
      await pauseAfterText;
      controller.enqueue(encoder.encode(`${frames.slice(split).join('')}data: [DONE]\n\n`));
      controller.close();
    },
  });
  return new Response(body, { headers });
}

function itemPage(data: Record<string, unknown>[], hasMore: boolean) {
  return {
    object: 'list',
    data,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
    has_more: hasMore,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
