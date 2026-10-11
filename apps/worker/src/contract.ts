import type { HarnessSession } from '@multi-harness/harness';
import type { PiBinding } from '@multi-harness/protocol/execution';

/** Bound native capability; execution owns each opened session through joined disposal. */
export interface PiTurnHost {
  readonly binding: PiBinding;
  openSession: (request: { threadId: string; nativeSessionId?: string }) => Promise<HarnessSession>;
}
