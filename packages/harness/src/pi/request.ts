import type { HarnessTurnInput } from '../contract.js';

/** Maps ordered text to Pi's prompt without separators, interpretation or file I/O. */
export function toNativeInput(input: HarnessTurnInput): string {
  // Command/template expansion, when enabled, remains native prompt behavior.
  let text = '';
  for (const part of input.content) {
    if (part.type !== 'text') throw new Error('Pi input currently supports text only');
    text += part.text;
  }
  return text;
}
