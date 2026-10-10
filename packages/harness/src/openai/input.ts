import { Buffer } from 'node:buffer';
import type { AgentInputItem, protocol } from '@openai/agents';

import type { HarnessInputPart, HarnessTurnInput } from '../contract.js';

// Vision formats are distinct from generic file transport; other MIME types are not rejected.
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/**
 * Maps ordered host content to native SDK input without file IO or format conversion.
 *
 * Inline data carries MIME; remote URLs retain their native reference. Successful mapping
 * does not establish provider format support or model understanding.
 */
export function toNativeInput(input: HarnessTurnInput): AgentInputItem[] {
  return [{ role: 'user', content: input.content.map(toNativeContent) }];
}

function toNativeContent(
  part: HarnessInputPart,
): protocol.InputText | protocol.InputImage | protocol.InputFile {
  if (part.type === 'text') return { type: 'input_text', text: part.text };

  const mimeType = part.mimeType.trim().toLowerCase();
  if (!MIME_TYPE_PATTERN.test(mimeType))
    throw new Error('OpenAI file input requires a MIME media type without parameters');
  if (part.filename !== undefined && part.filename.trim() === '')
    throw new Error('OpenAI file input filename must not be empty');

  const url = part.source instanceof URL ? part.source : undefined;
  if (url && url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'data:')
    throw new Error('OpenAI file input URL must use HTTP, HTTPS or data');

  // MIME names allow # and ^, which must be escaped inside a data URL (RFC 2397).
  const dataMimeType = mimeType.replace(/[#^]/g, encodeURIComponent);
  // Copy the visible byte view now; caller mutation must not change submitted native history.
  const source =
    part.source instanceof URL
      ? part.source.href
      : `data:${dataMimeType};base64,${Buffer.from(part.source).toString('base64')}`;
  if (IMAGE_MIME_TYPES.has(mimeType)) return { type: 'input_image', image: source };

  // An object URL avoids the SDK's string heuristic; data URLs belong in inline file_data.
  const file = url && url.protocol !== 'data:' ? { url: source } : source;
  return {
    type: 'input_file',
    file,
    ...(part.filename !== undefined ? { filename: part.filename } : {}),
  };
}
