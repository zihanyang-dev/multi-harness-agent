import { protocol } from '@openai/agents';
import { expect, it } from 'vitest';

import { toNativeInput } from './request.js';

it('preserves interleaved text, images and generic files without invented metadata', () => {
  expect(
    toNativeInput({
      content: [
        { type: 'text', text: 'Before' },
        { type: 'file', source: new Uint8Array([65]), mimeType: 'image/png' },
        { type: 'text', text: 'Between' },
        {
          type: 'file',
          source: new URL('https://files.example/document'),
          mimeType: 'application/pdf',
        },
        {
          type: 'file',
          source: new Uint8Array([66]),
          mimeType: 'application/custom',
          filename: 'report',
        },
      ],
    }),
  ).toEqual([
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'Before' },
        { type: 'input_image', image: 'data:image/png;base64,QQ==' },
        { type: 'input_text', text: 'Between' },
        { type: 'input_file', file: { url: 'https://files.example/document' } },
        { type: 'input_file', file: 'data:application/custom;base64,Qg==', filename: 'report' },
      ],
    },
  ]);
});

it('snapshots only the visible bytes and the current URL', () => {
  const bytes = new Uint8Array([0, 65, 66, 0]);
  const url = new URL('https://files.example/original');
  const native = toNativeInput({
    content: [
      { type: 'file', source: bytes.subarray(1, 3), mimeType: 'application/pdf' },
      { type: 'file', source: url, mimeType: 'application/pdf' },
    ],
  });
  bytes.fill(0);
  url.pathname = '/changed';
  expect(native).toEqual([
    {
      role: 'user',
      content: [
        { type: 'input_file', file: 'data:application/pdf;base64,QUI=' },
        { type: 'input_file', file: { url: 'https://files.example/original' } },
      ],
    },
  ]);
});

it('escapes data URL delimiters without changing existing percent escapes', () => {
  expect(
    toNativeInput({
      content: [
        { type: 'file', source: new Uint8Array([65]), mimeType: 'application/x#^' },
        { type: 'file', source: new URL('data:text/plain,a%20b#c^d'), mimeType: 'text/plain' },
      ],
    }),
  ).toEqual([
    {
      role: 'user',
      content: [
        { type: 'input_file', file: 'data:application/x%23%5E;base64,QQ==' },
        { type: 'input_file', file: 'data:text/plain,a%20b%23c%5Ed' },
      ],
    },
  ]);
});

it.each(['text/plain; charset=utf-8', 'text/plain\n', ' text/plain', 'text/', 'invalid'])(
  'rejects invalid MIME %j',
  (mimeType) => {
    expect(() =>
      toNativeInput({ content: [{ type: 'file', source: new Uint8Array(), mimeType }] }),
    ).toThrow(/MIME/);
  },
);

it('preserves an empty filename accepted by the native input schema', () => {
  const file = { type: 'input_file', file: 'data:text/plain;base64,', filename: '' };
  expect(protocol.InputFile.safeParse(file).success).toBe(true);
  expect(
    toNativeInput({
      content: [{ type: 'file', source: new Uint8Array(), mimeType: 'text/plain', filename: '' }],
    }),
  ).toEqual([{ role: 'user', content: [file] }]);
});

it('maps authorized URL references without fetching or inventing protocol policy', () => {
  const file = { type: 'input_file', file: { url: 'file:///authorized-marker' } };
  const image = { type: 'input_image', image: 'ftp://files.example/image.png' };
  expect(protocol.InputFile.safeParse(file).success).toBe(true);
  expect(protocol.InputImage.safeParse(image).success).toBe(true);
  expect(
    toNativeInput({
      content: [
        { type: 'file', source: new URL('file:///authorized-marker'), mimeType: 'text/plain' },
        { type: 'file', source: new URL('ftp://files.example/image.png'), mimeType: 'image/png' },
      ],
    }),
  ).toEqual([{ role: 'user', content: [file, image] }]);
});
