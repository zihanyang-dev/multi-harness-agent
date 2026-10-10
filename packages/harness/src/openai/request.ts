import { Buffer } from 'node:buffer';

import type { AgentInputItem, protocol } from '@openai/agents';

import type { HarnessInputPart, HarnessTurnInput } from '../contract.js';

const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
// RFC 2045 tokens exclude whitespace and MIME separators.
const MIME_TYPE_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`{|}~-]+\/[A-Za-z0-9!#$%&'*+.^_`{|}~-]+$/;

/** Maps ordered host content without file I/O, inferred metadata or format conversion. */
export function toNativeInput(input: HarnessTurnInput): AgentInputItem[] {
  // Snapshot ordered content synchronously, before execution can yield to caller mutations.
  return [{ role: 'user', content: input.content.map(toNativeContent) }];
}

function toNativeContent(
  part: HarnessInputPart,
): protocol.InputText | protocol.InputImage | protocol.InputFile {
  if (part.type === 'text') return { type: 'input_text', text: part.text };

  // Metadata selects the native representation; reject malformed values rather than infer replacements.
  const mimeType = part.mimeType;
  if (mimeType !== mimeType.trim() || !MIME_TYPE_PATTERN.test(mimeType)) {
    throw new Error('OpenAI file input requires a bare MIME media type without parameters');
  }

  // The host authorizes references; native SDK/provider validation decides format acceptance.
  const url = part.source instanceof URL ? part.source : undefined;

  // Copy the visible byte view before yielding control to the caller.
  let source =
    part.source instanceof URL
      ? part.source.href
      : `data:${escapeDataUrl(mimeType)};base64,${Buffer.from(part.source).toString('base64')}`;
  if (url?.protocol === 'data:') source = escapeDataUrl(source);
  if (IMAGE_MIME_TYPES.has(mimeType.toLowerCase())) return { type: 'input_image', image: source };

  // The SDK distinguishes a remote file URL object from inline file data.
  const file = url && url.protocol !== 'data:' ? { url: source } : source;
  return {
    type: 'input_file',
    file,
    ...(part.filename !== undefined ? { filename: part.filename } : {}),
  };
}

function escapeDataUrl(value: string): string {
  // Escape delimiters without decoding existing escapes or changing remote URL fragments.
  return value.replaceAll('#', '%23').replaceAll('^', '%5E');
}
