import type { BaseEvent, Message } from '@ag-ui/core';

import type { HarnessMcpServer } from './mcp.js';
import type { HarnessSkillsOptions } from './skill.js';
import type { HarnessTool } from './tool.js';

export type HarnessId = 'pi' | 'openai' | 'claude';

/** Capabilities must be verified by each adapter before production admission. */
export interface HarnessCapabilities {
  readonly resume: boolean;
  readonly steer: boolean;
  readonly visibleReasoning: boolean;
  readonly customTools: boolean;
  readonly mcp: boolean;
  readonly skills: boolean;
}

/** Adapters must reject unsupported requested capabilities rather than silently ignore them. */
export interface OpenHarnessSessionOptions {
  cwd: string;
  nativeSessionId?: string;
  tools?: readonly HarnessTool[];
  mcpServers?: readonly HarnessMcpServer[];
  skills?: HarnessSkillsOptions;
}

/** Files are prepared by the host; adapters map supported parts to native SDK content. */
export type HarnessInputPart =
  | { type: 'text'; text: string }
  | {
      type: 'file';
      /** An authorized URL or inline bytes, not a business file ID or storage client. */
      source: URL | Uint8Array;
      mimeType: string;
      filename?: string;
    };

/** Preserves host input order; native support is checked by the selected adapter. */
export interface HarnessTurnInput {
  content: readonly HarnessInputPart[];
}

/** Public output is not a portable native checkpoint. Execution failures reject the result. */
export interface HarnessTurnResult {
  status: 'completed' | 'cancelled';
  messages: readonly Message[];
}

export interface HarnessRun {
  readonly events: AsyncIterable<BaseEvent>;
  readonly result: Promise<HarnessTurnResult>;
  /** Requests interruption; the result reports actual completion separately. */
  interrupt: () => Promise<void>;
}

/** Owns one native session; callers must serialize access to its writable state. */
export interface HarnessSession {
  readonly nativeSessionId: string;
  run: (input: HarnessTurnInput) => Promise<HarnessRun>;
  dispose: () => Promise<void>;
}

export interface HarnessProvider {
  readonly id: HarnessId;
  readonly capabilities: HarnessCapabilities;
  openSession: (options: OpenHarnessSessionOptions) => Promise<HarnessSession>;
}
