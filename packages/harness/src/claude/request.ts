import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { HarnessTurnInput } from '../contract.js';

export interface InputStream {
  prompt: AsyncIterable<SDKUserMessage>;
  submit: (message: SDKUserMessage) => void;
  close: () => void;
}

/** Maps text synchronously; native command/mention expansion remains host-configured behavior. */
export function toNativeInput(input: HarnessTurnInput): string {
  let text = '';
  for (const part of input.content) {
    if (part.type !== 'text') throw new Error('Claude input currently supports text only');
    text += part.text;
  }
  return text;
}

/** Keeps one input iterable open for the native Query, without a local prompt backlog. */
export function createInputStream(): InputStream {
  let closed = false;
  let pending: SDKUserMessage | undefined;
  let wake = Promise.withResolvers<void>();
  return {
    prompt: (async function* () {
      while (!closed) {
        if (pending === undefined) await wake.promise;
        if (closed) return;
        const message = pending;
        // Free the handoff slot before yielding; session admission owns turn serialization.
        pending = undefined;
        wake = Promise.withResolvers<void>();
        if (message !== undefined) yield message;
      }
    })(),
    submit: (message) => {
      if (closed) throw new Error('Claude input stream is closed');
      if (pending !== undefined)
        throw new Error('Claude input stream already has a pending prompt');
      pending = message;
      wake.resolve();
    },
    close: () => {
      // SDK teardown cannot wake a custom input generator's outstanding wait for us.
      closed = true;
      pending = undefined;
      wake.resolve();
    },
  };
}
