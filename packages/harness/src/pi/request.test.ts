import { expect, it } from 'vitest';

import type { HarnessTurnInput } from '../contract.js';
import { toNativeInput } from './request.js';

it('preserves text without trimming or interpreting native commands', () => {
  const text = '  /command\nUnicode: π 🎬\n  ';

  expect(toNativeInput({ content: [{ type: 'text', text }] })).toBe(text);
});

it('combines ordered text parts without inserting separators', () => {
  const input: HarnessTurnInput = {
    content: [
      { type: 'text', text: 'First\n' },
      { type: 'text', text: '' },
      { type: 'text', text: 'Second' },
      { type: 'text', text: ' third' },
    ],
  };

  expect(toNativeInput(input)).toBe('First\nSecond third');
});

it('does not invent text for empty content', () => {
  expect(toNativeInput({ content: [] })).toBe('');
});

it.each([
  { source: new Uint8Array([1, 2, 3]), mimeType: 'image/png' },
  { source: new URL('https://example.com/input.pdf'), mimeType: 'application/pdf' },
])('rejects file input instead of silently dropping it: $mimeType', ({ source, mimeType }) => {
  expect(() =>
    toNativeInput({
      content: [
        { type: 'text', text: 'Before' },
        { type: 'file', source, mimeType },
        { type: 'text', text: 'After' },
      ],
    }),
  ).toThrow(/text only/);
});
