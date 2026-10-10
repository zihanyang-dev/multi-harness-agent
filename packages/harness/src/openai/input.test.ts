import { Buffer } from 'node:buffer';
import { EventType } from '@ag-ui/core';
import { MemorySession, OpenAIConversationsSession } from '@openai/agents';
import { describe, expect, it, vi } from 'vitest';

import { PDF_DATA, RED_IMAGE } from '../../tests/fixtures/media.js';
import {
  createOpenAIClientFixture,
  type OpenAIClientFixture,
} from '../../tests/fixtures/openai-client.js';
import { createOpenAIHarness, type HarnessSession } from '../index.js';

// These names exercise generic transport, not decoding or model acceptance of each format.
const fileCases = [
  { filename: 'report.pdf', mimeType: 'application/pdf' },
  { filename: 'notes.txt', mimeType: 'text/plain' },
  { filename: 'notes.md', mimeType: 'text/markdown' },
  { filename: 'data.json', mimeType: 'application/json' },
  { filename: 'data.csv', mimeType: 'text/csv' },
  {
    filename: 'report.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  {
    filename: 'table.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  {
    filename: 'slides.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
  { filename: 'archive.zip', mimeType: 'application/zip' },
  { filename: 'bytes.bin', mimeType: 'application/octet-stream' },
  { filename: 'diagram.svg', mimeType: 'image/svg+xml' },
  { filename: 'recording.wav', mimeType: 'audio/wav' },
  { filename: 'clip.mp4', mimeType: 'video/mp4' },
  { filename: 'custom.asset', mimeType: 'application/x-custom' },
];

const imageCases = [
  { filename: 'photo.png', mimeType: 'image/png' },
  { filename: 'photo.jpg', mimeType: 'image/jpeg' },
  { filename: 'photo.webp', mimeType: 'image/webp' },
  { filename: 'photo.gif', mimeType: 'image/gif' },
];

describe('OpenAI native file input', () => {
  it.each(fileCases)(
    'forwards a generic URL attachment ($filename)',
    async ({ filename, mimeType }) => {
      const fixture = createOpenAIClientFixture();
      fixture.enqueue('Accepted');
      const session = await openInputSession(fixture);
      const url = `https://files.invalid/${filename}?version=1`;
      try {
        await (
          await session.run({
            content: [{ type: 'file', source: new URL(url), mimeType, filename }],
          })
        ).result;
        expect(fixture.requests.map((request) => request.path)).toEqual(['/responses']);
        expect(fixture.requests[0]?.body?.input).toEqual([
          { role: 'user', content: [{ type: 'input_file', file_url: url, filename }] },
        ]);
      } finally {
        await session.dispose();
      }
    },
  );

  it.each(fileCases)(
    'encodes generic inline bytes with MIME and filename ($filename)',
    async ({ filename, mimeType }) => {
      const fixture = createOpenAIClientFixture();
      fixture.enqueue('Accepted');
      const session = await openInputSession(fixture);
      try {
        await (
          await session.run({
            content: [{ type: 'file', source: new Uint8Array([1, 2]), mimeType, filename }],
          })
        ).result;
        expect(fixture.requests[0]?.body?.input).toEqual([
          {
            role: 'user',
            content: [{ type: 'input_file', file_data: `data:${mimeType};base64,AQI=`, filename }],
          },
        ]);
      } finally {
        await session.dispose();
      }
    },
  );

  it.each(imageCases)(
    'routes a supported image URL through native vision content ($mimeType)',
    async ({ filename, mimeType }) => {
      const fixture = createOpenAIClientFixture();
      fixture.enqueue('Accepted');
      const session = await openInputSession(fixture);
      const url = `https://files.invalid/${filename}`;
      try {
        await (
          await session.run({
            content: [{ type: 'file', source: new URL(url), mimeType, filename }],
          })
        ).result;
        expect(fixture.requests[0]?.body?.input).toEqual([
          { role: 'user', content: [{ type: 'input_image', image_url: url, detail: 'auto' }] },
        ]);
      } finally {
        await session.dispose();
      }
    },
  );

  it.each(imageCases)(
    'encodes vision bytes with the supplied image MIME ($mimeType)',
    async ({ mimeType }) => {
      const fixture = createOpenAIClientFixture();
      fixture.enqueue('Accepted');
      const session = await openInputSession(fixture);
      try {
        await (
          await session.run({
            content: [{ type: 'file', source: new Uint8Array([1, 2]), mimeType }],
          })
        ).result;
        expect(fixture.requests[0]?.body?.input).toEqual([
          {
            role: 'user',
            content: [
              { type: 'input_image', image_url: `data:${mimeType};base64,AQI=`, detail: 'auto' },
            ],
          },
        ]);
      } finally {
        await session.dispose();
      }
    },
  );

  it('preserves an image data URL through native vision content', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueue('Accepted');
    const session = await openInputSession(fixture);
    try {
      await (
        await session.run({
          content: [
            {
              type: 'file',
              source: new URL(`data:image/png;base64,${RED_IMAGE}`),
              mimeType: 'image/png',
            },
          ],
        })
      ).result;
      expect(fixture.requests[0]?.body?.input).toEqual([
        {
          role: 'user',
          content: [
            {
              type: 'input_image',
              image_url: `data:image/png;base64,${RED_IMAGE}`,
              detail: 'auto',
            },
          ],
        },
      ]);
    } finally {
      await session.dispose();
    }
  });

  it('rejects an invalid later part before native history reads and releases admission', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueue('Recovered');
    const nativeSession = new MemorySession();
    const session = await openInputSession(fixture, nativeSession);
    const getItems = vi.spyOn(nativeSession, 'getItems');
    try {
      await expect(
        session.run({
          content: [
            { type: 'text', text: 'First' },
            { type: 'file', source: new Uint8Array([1, 2]), mimeType: 'text/plain' },
            { type: 'file', source: new Uint8Array([3]), mimeType: '' },
          ],
        }),
      ).rejects.toThrow(/MIME media type/);
      expect(getItems).not.toHaveBeenCalled();
      expect(fixture.requests).toEqual([]);
      await (await session.run({ content: [{ type: 'text', text: 'Continue' }] })).result;
      expect(getItems).toHaveBeenCalled();
      expect(fixture.requests[0]?.body?.input).toEqual([
        { role: 'user', content: [{ type: 'input_text', text: 'Continue' }] },
      ]);
    } finally {
      await session.dispose();
      getItems.mockRestore();
    }
  });

  it('replays file data and URLs through an explicitly configured Conversations backend', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueue('First answer', 'Second answer');
    const provider = createOpenAIHarness({
      client: fixture.client,
      model: 'configured-model',
      sessions: {
        resumable: true,
        open: async (conversationId) =>
          new OpenAIConversationsSession({
            client: fixture.client,
            ...(conversationId !== undefined ? { conversationId } : {}),
          }),
      },
    });
    const session = await provider.openSession({ cwd: process.cwd() });
    try {
      await (
        await session.run({
          content: [
            {
              type: 'file',
              source: new Uint8Array([1, 2]),
              mimeType: 'application/octet-stream',
              filename: 'data.bin',
            },
            {
              type: 'file',
              source: new URL('https://files.invalid/report.csv'),
              mimeType: 'text/csv',
              filename: 'report.csv',
            },
          ],
        })
      ).result;
    } finally {
      await session.dispose();
    }
    const reopened = await provider.openSession({
      cwd: process.cwd(),
      nativeSessionId: session.nativeSessionId,
    });
    try {
      await (await reopened.run({ content: [{ type: 'text', text: 'Continue' }] })).result;
      const modelRequests = fixture.requests.filter((request) => request.path === '/responses');
      expect(modelRequests).toHaveLength(2);
      expect(modelRequests[1]?.body?.input).toEqual([
        expect.objectContaining({
          role: 'user',
          content: [
            {
              type: 'input_file',
              file_data: 'data:application/octet-stream;base64,AQI=',
              filename: 'data.bin',
            },
            {
              type: 'input_file',
              file_url: 'https://files.invalid/report.csv',
              filename: 'report.csv',
            },
          ],
        }),
        expect.objectContaining({ role: 'assistant' }),
        { role: 'user', content: [{ type: 'input_text', text: 'Continue' }] },
      ]);
    } finally {
      await reopened.dispose();
    }
  });

  it('preserves interleaved text, inline images, URL files and inline PDF data', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueue('Answer');
    const session = await openInputSession(fixture);
    try {
      const run = await session.run({
        content: [
          { type: 'text', text: 'First' },
          { type: 'file', source: Buffer.from(RED_IMAGE, 'base64'), mimeType: 'image/png' },
          { type: 'text', text: 'Second' },
          {
            type: 'file',
            source: new URL('https://files.invalid/data.csv?signature=fixture'),
            mimeType: 'text/csv',
            filename: 'data.csv',
          },
          {
            type: 'file',
            source: Buffer.from(PDF_DATA, 'base64'),
            mimeType: 'application/pdf',
            filename: 'report.pdf',
          },
          { type: 'text', text: 'Last' },
        ],
      });
      const events = [];
      for await (const event of run.events) events.push(event);
      expect((await run.result).messages).toEqual([
        { id: 'msg_fixture_1', role: 'assistant', content: 'Answer' },
      ]);
      expect(events.at(-1)).toMatchObject({
        type: EventType.RUN_FINISHED,
        outcome: { type: 'success' },
      });
      expect(fixture.requests[0]?.body?.input).toEqual([
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'First' },
            {
              type: 'input_image',
              image_url: `data:image/png;base64,${RED_IMAGE}`,
              detail: 'auto',
            },
            { type: 'input_text', text: 'Second' },
            {
              type: 'input_file',
              file_url: 'https://files.invalid/data.csv?signature=fixture',
              filename: 'data.csv',
            },
            {
              type: 'input_file',
              file_data: `data:application/pdf;base64,${PDF_DATA}`,
              filename: 'report.pdf',
            },
            { type: 'input_text', text: 'Last' },
          ],
        },
      ]);
    } finally {
      await session.dispose();
    }
  });

  it('retains file history and snapshots only the visible byte view for the next turn', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueue('First answer', 'Second answer');
    const nativeSession = new MemorySession();
    const session = await openInputSession(fixture, nativeSession);
    const bytes = new Uint8Array([9, 1, 2, 9]).subarray(1, 3);
    try {
      const first = await session.run({
        content: [
          { type: 'text', text: 'Inspect' },
          {
            type: 'file',
            source: bytes,
            mimeType: 'application/octet-stream',
            filename: 'view.bin',
          },
          {
            type: 'file',
            source: new URL('https://files.invalid/photo.png'),
            mimeType: 'image/png',
          },
        ],
      });
      bytes.fill(0);
      await first.result;
      await (await session.run({ content: [{ type: 'text', text: 'Continue' }] })).result;
      expect(fixture.requests[1]?.body?.input).toEqual([
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Inspect' },
            {
              type: 'input_file',
              file_data: 'data:application/octet-stream;base64,AQI=',
              filename: 'view.bin',
            },
            { type: 'input_image', image_url: 'https://files.invalid/photo.png', detail: 'auto' },
          ],
        },
        expect.objectContaining({ role: 'assistant' }),
        { role: 'user', content: [{ type: 'input_text', text: 'Continue' }] },
      ]);
      expect((await nativeSession.getItems())[0]).toMatchObject({
        role: 'user',
        content: [
          { type: 'input_text', text: 'Inspect' },
          {
            type: 'input_file',
            file: 'data:application/octet-stream;base64,AQI=',
            filename: 'view.bin',
          },
          { type: 'input_image', image: 'https://files.invalid/photo.png' },
        ],
      });
    } finally {
      await session.dispose();
    }
  });

  it.each([
    { mimeType: 'application/x#custom', dataUrl: 'data:application/x%23custom;base64,AQI=' },
    { mimeType: 'application/x^custom', dataUrl: 'data:application/x%5Ecustom;base64,AQI=' },
  ])(
    'escapes valid MIME name characters in inline data URLs ($mimeType)',
    async ({ mimeType, dataUrl }) => {
      const fixture = createOpenAIClientFixture();
      fixture.enqueue('Accepted');
      const session = await openInputSession(fixture);
      try {
        await (
          await session.run({
            content: [
              { type: 'file', source: new Uint8Array([1, 2]), mimeType, filename: 'custom.asset' },
            ],
          })
        ).result;
        expect(fixture.requests[0]?.body?.input).toEqual([
          {
            role: 'user',
            content: [{ type: 'input_file', file_data: dataUrl, filename: 'custom.asset' }],
          },
        ]);
        expect(new URL(dataUrl).hash).toBe('');
        expect(decodeURIComponent(new URL(dataUrl).pathname)).toBe(`${mimeType};base64,AQI=`);
      } finally {
        await session.dispose();
      }
    },
  );

  it('leaves a URL filename optional instead of inventing file metadata', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueue('Accepted');
    const session = await openInputSession(fixture);
    try {
      await (
        await session.run({
          content: [
            {
              type: 'file',
              source: new URL('http://files.invalid/reference.txt'),
              mimeType: 'text/plain',
            },
          ],
        })
      ).result;
      expect(fixture.requests[0]?.body?.input).toEqual([
        {
          role: 'user',
          content: [{ type: 'input_file', file_url: 'http://files.invalid/reference.txt' }],
        },
      ]);
    } finally {
      await session.dispose();
    }
  });

  it('canonicalizes MIME casing without deriving type from the URL extension', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueue('Accepted');
    const session = await openInputSession(fixture);
    try {
      await (
        await session.run({
          content: [
            {
              type: 'file',
              source: new URL('https://files.invalid/opaque'),
              mimeType: ' IMAGE/PNG ',
            },
          ],
        })
      ).result;
      expect(fixture.requests[0]?.body?.input).toEqual([
        {
          role: 'user',
          content: [
            { type: 'input_image', image_url: 'https://files.invalid/opaque', detail: 'auto' },
          ],
        },
      ]);
    } finally {
      await session.dispose();
    }
  });

  it('does not require or invent a filename for inline generic files', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueue('Accepted');
    const session = await openInputSession(fixture);
    try {
      await (
        await session.run({
          content: [{ type: 'file', source: new Uint8Array([1, 2]), mimeType: ' TEXT/CSV ' }],
        })
      ).result;
      expect(fixture.requests[0]?.body?.input).toEqual([
        { role: 'user', content: [{ type: 'input_file', file_data: 'data:text/csv;base64,AQI=' }] },
      ]);
    } finally {
      await session.dispose();
    }
  });

  it('preserves a data URL as inline file data rather than a remote URL', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueue('Accepted');
    const session = await openInputSession(fixture);
    try {
      await (
        await session.run({
          content: [
            {
              type: 'file',
              source: new URL('data:text/plain;base64,AQI='),
              mimeType: 'text/plain',
              filename: 'inline.txt',
            },
          ],
        })
      ).result;
      expect(fixture.requests[0]?.body?.input).toEqual([
        {
          role: 'user',
          content: [
            {
              type: 'input_file',
              file_data: 'data:text/plain;base64,AQI=',
              filename: 'inline.txt',
            },
          ],
        },
      ]);
    } finally {
      await session.dispose();
    }
  });

  it.each([
    '',
    '  ',
    'application',
    'application/pdf; charset=utf-8',
    'text/plain\r\nX-Header: invalid',
  ])('rejects malformed MIME metadata before starting native turn work (%j)', async (mimeType) => {
    const fixture = createOpenAIClientFixture();
    const session = await openInputSession(fixture);
    try {
      await expect(
        session.run({
          content: [{ type: 'file', source: new Uint8Array([1, 2]), mimeType }],
        }),
      ).rejects.toThrow(/MIME media type/);
      expect(fixture.requests).toEqual([]);
    } finally {
      await session.dispose();
    }
  });

  it.each(['', '  '])(
    'rejects an explicitly empty filename instead of dropping it (%j)',
    async (filename) => {
      const fixture = createOpenAIClientFixture();
      const session = await openInputSession(fixture);
      try {
        await expect(
          session.run({
            content: [
              {
                type: 'file',
                source: new URL('https://files.invalid/report.pdf'),
                mimeType: 'application/pdf',
                filename,
              },
            ],
          }),
        ).rejects.toThrow(/filename/);
        expect(fixture.requests).toEqual([]);
      } finally {
        await session.dispose();
      }
    },
  );

  it.each([
    'file:///workspace/private.pdf',
    'blob:https://files.invalid/example',
    'ftp://files.invalid/report.pdf',
  ])('rejects URLs outside the native remote or inline source forms (%s)', async (url) => {
    const fixture = createOpenAIClientFixture();
    const session = await openInputSession(fixture);
    try {
      await expect(
        session.run({
          content: [{ type: 'file', source: new URL(url), mimeType: 'application/pdf' }],
        }),
      ).rejects.toThrow(/URL/);
      expect(fixture.requests).toEqual([]);
    } finally {
      await session.dispose();
    }
  });

  it('preserves a model service file rejection without falling back to text', async () => {
    const fixture = createOpenAIClientFixture();
    fixture.enqueueError(400, 'Private unsupported file diagnostic');
    fixture.enqueue('Recovered');
    const session = await openInputSession(fixture);
    try {
      const run = await session.run({
        content: [
          {
            type: 'file',
            source: new URL('https://files.invalid/archive.zip'),
            mimeType: 'application/zip',
          },
        ],
      });
      const rejection = expect(run.result).rejects.toThrow(/400/);
      const events = [];
      for await (const event of run.events) events.push(event);
      await rejection;
      expect(events.at(-1)).toEqual({ type: EventType.RUN_ERROR, message: 'OpenAI run failed' });
      expect(JSON.stringify(events)).not.toContain('Private unsupported file diagnostic');
      expect(fixture.requests[0]?.body?.input).toEqual([
        {
          role: 'user',
          content: [{ type: 'input_file', file_url: 'https://files.invalid/archive.zip' }],
        },
      ]);
      expect(
        (await (await session.run({ content: [{ type: 'text', text: 'Continue' }] })).result)
          .status,
      ).toBe('completed');
      expect(fixture.requests).toHaveLength(2);
    } finally {
      await session.dispose();
    }
  });
});

/** Uses the public adapter and real SDK, with only the HTTP transport substituted. */
function openInputSession(
  fixture: OpenAIClientFixture,
  nativeSession = new MemorySession(),
): Promise<HarnessSession> {
  return createOpenAIHarness({
    client: fixture.client,
    model: 'configured-model',
    modelSettings: { store: false },
    sessions: { resumable: false, open: async () => nativeSession },
  }).openSession({ cwd: process.cwd() });
}
