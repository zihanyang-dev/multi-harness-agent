import type {
  HarnessSession,
  JsonValue,
  McpServerConfig,
  ResumeSessionOptions,
  SessionOptions,
  SkillSource,
  TokenUsage,
  ToolDefinition,
  ToolOutput,
  ToolResult,
} from '@multi-harness/harness';

// Type-only consumers: these are host bindings, not native execution or validation evidence.
export const lookupWeather: ToolDefinition = {
  name: 'lookup_weather',
  description: 'Look up the weather for a city.',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { temperature: { type: 'number' } },
    required: ['temperature'],
    additionalProperties: false,
  },
  exposure: 'deferred',
  async execute(input, { signal }): Promise<ToolOutput> {
    signal.throwIfAborted();
    if (typeof input.city !== 'string') throw new Error('Expected a city.');
    return {
      content: [{ type: 'text', text: `Weather for ${input.city}.` }],
      structuredContent: { temperature: 20 },
      isError: false,
    };
  },
};

export const writingSkill: SkillSource = { directory: '/workspace/skills/writing' };
export const calendarServer: McpServerConfig = {
  name: 'calendar',
  transport: {
    type: 'http',
    url: 'https://calendar.example.test/mcp',
    headers: { Authorization: 'Bearer host-supplied-test-token' },
  },
  allowedTools: ['list_events'],
  exposure: 'deferred',
};
export const localServer: McpServerConfig = {
  name: 'local_catalog',
  transport: {
    type: 'stdio',
    command: '/opt/tools/catalog-server',
    args: ['--stdio'],
    env: { CATALOG_TOKEN: 'host-supplied-test-token' },
  },
  allowedTools: 'all',
};
export const disabledServerTools: McpServerConfig = {
  ...calendarServer,
  allowedTools: [],
};

// Pi-only builtin spelling; this selection is not a portable native-name alias.
export function piResourceOptions(options: SessionOptions): SessionOptions {
  return {
    ...options,
    nativeTools: ['read'],
    tools: [lookupWeather],
    skills: [writingSkill],
    mcpServers: [calendarServer, localServer],
    projectToolResult(_output, tool): ToolResult | undefined {
      if (tool.name !== 'lookup_weather' || tool.phase !== 'finished') return undefined;
      // Choose payload only; the implementation independently preserves confirmed error facts.
      return { content: [{ type: 'text', text: 'Weather lookup finished.' }] };
    },
  };
}

export function resumePiWithResources(
  options: SessionOptions,
  sessionId: string,
): ResumeSessionOptions {
  return { ...piResourceOptions(options), sessionId };
}

export const usageWithCache: TokenUsage = {
  inputTokens: 1200,
  outputTokens: 200,
  cacheReadTokens: 800,
  cacheWriteTokens: 100,
};
export const cacheReadWithoutWrite: TokenUsage = { inputTokens: 1000, cacheReadTokens: 800 };
// A complete cache counter does not imply a complete input total or a reported write counter.
export const cacheReadWithoutInput: TokenUsage = { cacheReadTokens: 800 };
// Empty disclosure is legal only with confirmed result evidence; this declares the DTO, not execution.
export const emptyConfirmedView: ToolResult = { content: [], isError: true };
export const outputWithoutPublication: ToolOutput = {
  content: [{ type: 'text', text: 'Private model-facing result.' }],
  structuredContent: { internalReference: 'private-reference' },
};
export const sizeLimitedView: ToolResult = {
  content: [{ type: 'text', text: 'Retained public excerpt.' }],
  truncated: true,
};

export function rejectToolSchemaArray(tool: ToolDefinition): void {
  // @ts-expect-error Tool arguments require an object-root schema, not an array root.
  const invalid: ToolDefinition = { ...tool, inputSchema: { type: 'array' } };
  void invalid;
}

export function rejectExecutableSchema(tool: ToolDefinition): void {
  // @ts-expect-error Public schemas contain JSON data, not SDK parsers or schema methods.
  const invalid: ToolDefinition = { ...tool, inputSchema: { type: 'object', parse: () => ({}) } };
  void invalid;
}

export function rejectToolWithoutExecution(tool: Omit<ToolDefinition, 'execute'>): void {
  // @ts-expect-error A descriptor alone cannot bind a result-bearing application tool.
  const invalid: ToolDefinition = tool;
  void invalid;
}

export function rejectSynchronousExecutor(tool: ToolDefinition): void {
  // @ts-expect-error Execution returns an awaited outcome, not a dispatch acknowledgement.
  const invalid: ToolDefinition = { ...tool, execute: () => ({ content: [] }) };
  void invalid;
}

export function rejectModelTruncation(output: ToolOutput): void {
  // @ts-expect-error Projection truncation belongs to the public view, not the model output.
  const invalid: ToolOutput = { ...output, truncated: true };
  void invalid;
}

export function rejectInlineSkillBody(skill: SkillSource): void {
  // @ts-expect-error Skill body and metadata come from its native source, not a prompt fallback.
  const invalid: SkillSource = { ...skill, content: 'Run these instructions.' };
  void invalid;
}

export function rejectUnscopedServer(server: Omit<McpServerConfig, 'allowedTools'>): void {
  // @ts-expect-error Server tool scope must explicitly select names or all.
  const invalid: McpServerConfig = server;
  void invalid;
}

export function rejectMixedTransport(): void {
  const invalid: McpServerConfig['transport'] = {
    type: 'http',
    url: 'https://example.test/mcp',
    // @ts-expect-error HTTP configuration cannot also supply a stdio command.
    command: '/opt/server',
  };
  void invalid;
}

export function rejectNativeServerInstance(server: McpServerConfig): void {
  // @ts-expect-error The adapter creates SDK server instances internally.
  const invalid: McpServerConfig = { ...server, instance: { connect: async () => undefined } };
  void invalid;
}

export function rejectUniversalLazyFlag(options: SessionOptions): void {
  // @ts-expect-error Native discovery governs loading; there is no cross-resource lazy switch.
  const invalid: SessionOptions = { ...options, lazy: true };
  void invalid;
}

export function rejectAsyncProjection(options: SessionOptions): void {
  // @ts-expect-error Projection is synchronous and cannot own asynchronous execution or continuation.
  const invalid: SessionOptions = { ...options, projectToolResult: async () => ({ content: [] }) };
  void invalid;
}

export function rejectCacheCreationAlias(usage: TokenUsage): void {
  // @ts-expect-error Cache creation and write are one normalized counter, not two aliases.
  const invalid: TokenUsage = { ...usage, cacheCreationTokens: 100 };
  void invalid;
}

export async function rejectPublicDiscoveryLoop(session: HarnessSession): Promise<void> {
  // @ts-expect-error Tool discovery belongs to the native loop, not a public control method.
  await session.toolSearch('weather');
}

export function rejectNonJsonStructuredResult(output: ToolOutput): void {
  // @ts-expect-error Model result data cannot contain executable functions.
  const invalid: ToolOutput = { ...output, structuredContent: { resolve: () => 'secret' } };
  void invalid;
}

export function resultData(output: ToolOutput): JsonValue | undefined {
  return output.structuredContent;
}
