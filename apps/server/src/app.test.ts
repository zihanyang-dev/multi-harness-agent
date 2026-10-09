import { expect, it } from 'vitest';
import { createApp } from './app.js';

it('serves liveness without requiring infrastructure or cloud credentials', async () => {
  const response = await createApp().request('/healthz');

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok' });
});
