import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

export interface ExecuteHarnessToolOptions {
  /** Untrusted protocol input; the concrete tool owns runtime schema validation. */
  input: Record<string, unknown>;
  signal?: AbortSignal;
}

/** Portable custom tool; native SDK tools keep their own definitions and behavior. */
export interface HarnessTool {
  readonly definition: Tool;
  /** Validate input and enforce business authorization in the assigned implementation. */
  execute: (options: ExecuteHarnessToolOptions) => Promise<CallToolResult>;
}
