import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command:
        process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL
          ? 'pnpm exec tsx --conditions=development tests/e2e/server.fixture.ts'
          : 'pnpm exec tsx --conditions=development apps/server/src/main.ts',
      url: 'http://127.0.0.1:3001/healthz',
      env: { HOST: '127.0.0.1', PORT: '3001', AGENT_BACKEND_ENABLED: '0' },
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @multi-harness/web dev --port 5174 --strictPort',
      url: 'http://127.0.0.1:5174',
      env: { WEB_API_PROXY_TARGET: 'http://127.0.0.1:3001' },
      reuseExistingServer: false,
    },
  ],
});
