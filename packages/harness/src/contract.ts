import type { BaseEvent, Message } from '@ag-ui/core';

export type HarnessId = 'pi' | 'openai' | 'claude';

/** Host scope and history identity; SDK capabilities are configured on native objects. */
export interface OpenHarnessSessionOptions {
  cwd: string;
  nativeSessionId?: string;
}

/** Files are prepared by the host; adapters map supported parts to native SDK content. */
export type HarnessInputPart =
  | { type: 'text'; text: string }
  | {
      type: 'file';
      /** An authorized URL or inline bytes, not a business file ID or storage client. */
      source: URL | Uint8Array;
      /** A MIME media type; native format acceptance depends on the selected adapter and model. */
      mimeType: string;
      /** Native image content may not have a filename field; the host retains business metadata. */
      filename?: string;
    };

/** Preserves host input order; native support is checked by the selected adapter. */
export interface HarnessTurnInput {
  content: readonly HarnessInputPart[];
}

/** Public output is not a portable native checkpoint. Execution failures reject the result. */
export interface HarnessTurnResult {
  status: 'completed' | 'cancelled' | 'paused';
  messages: readonly Message[];
}

export interface HarnessRun {
  /** Single observation; stopping consumption does not cancel execution. Timing is adapter-specific. */
  readonly events: AsyncIterable<BaseEvent>;
  readonly result: Promise<HarnessTurnResult>;
  /** Requests interruption; the result reports actual completion separately. */
  interrupt: () => Promise<void>;
}

/** Coordinates local submissions; the host coordinates other writers and native resource owners. */
export interface HarnessSession {
  readonly nativeSessionId: string;
  run: (input: HarnessTurnInput) => Promise<HarnessRun>;
  dispose: () => Promise<void>;
}

export interface HarnessProvider {
  readonly id: HarnessId;
  /** Host-verified history reopening, not native capability inventory or crash recovery. */
  readonly resumable: boolean;
  openSession: (options: OpenHarnessSessionOptions) => Promise<HarnessSession>;
}
