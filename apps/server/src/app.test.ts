import { expect, it } from 'vitest';
import { createApp } from './app.js';

it('does not mount authenticated product routes without complete infrastructure options', async () => {
  expect((await createApp().request('/threads', { method: 'POST' })).status).toBe(404);
  expect((await createApp().request('/auth/get-session')).status).toBe(404);
});

it('serves liveness without requiring infrastructure or cloud credentials', async () => {
  const response = await createApp().request('/healthz');

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok' });
});
