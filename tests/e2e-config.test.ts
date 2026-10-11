import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => vi.unstubAllEnvs());

test('browser liveness fallback cannot load the developer env file or activate the backend', async () => {
  vi.stubEnv('TEST_DATABASE_URL', undefined);
  vi.stubEnv('TEST_REDIS_URL', undefined);
  const config = (await import('../playwright.config.js')).default;
  if (!Array.isArray(config.webServer)) throw new Error('Expected explicit browser services.');
  const server = config.webServer[0];
  expect(server?.command).toBe('pnpm exec tsx --conditions=development apps/server/src/main.ts');
  expect(server?.env?.AGENT_BACKEND_ENABLED).toBe('0');
  expect(server?.reuseExistingServer).toBe(false);
});
