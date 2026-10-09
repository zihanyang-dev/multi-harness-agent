import type { HarnessTurnInput } from '../src/contract.js';

// Checked by the harness TypeScript project; these are not runtime SDK tests.
export const preparedInputs: readonly HarnessTurnInput[] = [
  {
    content: [
      { type: 'text', text: 'Use this reference.' },
      {
        type: 'file',
        source: new URL('https://files.example/reference.png'),
        mimeType: 'image/png',
        filename: 'reference.png',
      },
      { type: 'text', text: 'Keep the same visual style.' },
    ],
  },
  {
    content: [
      { type: 'file', source: new Uint8Array([1, 2, 3]), mimeType: 'application/octet-stream' },
    ],
  },
];

// @ts-expect-error Text is represented as ordered content rather than a parallel field.
export const legacyInput: HarnessTurnInput = { text: 'Legacy input' };

export const businessIdentityInput: HarnessTurnInput = {
  content: [
    {
      type: 'file',
      source: new URL('https://files.example/reference.png'),
      mimeType: 'image/png',
      // @ts-expect-error Business file identities do not belong in the harness contract.
      fileId: 'business-file',
    },
  ],
};

export const untypedFile: HarnessTurnInput = {
  content: [
    // @ts-expect-error Every prepared file identifies its MIME type.
    { type: 'file', source: new Uint8Array([1]) },
  ],
};
