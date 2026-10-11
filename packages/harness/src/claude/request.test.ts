import { expect, it } from 'vitest';

import { toNativeInput } from './request.js';

it('preserves ordered text and leaves command/template interpretation native', () => {
  expect(
    toNativeInput({
      content: [
        { type: 'text', text: '/command ' },
        { type: 'text', text: '@file\n{{template}}' },
      ],
    }),
  ).toBe('/command @file\n{{template}}');
  expect(toNativeInput({ content: [] })).toBe('');
});

it('rejects interleaved files without doing IO or silently dropping parts', () => {
  expect(() =>
    toNativeInput({
      content: [
        { type: 'text', text: 'before' },
        {
          type: 'file',
          source: new URL('https://example.test/private.png'),
          mimeType: 'image/png',
        },
        { type: 'text', text: 'after' },
      ],
    }),
  ).toThrow('text only');
});
