import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter @multi-harness/server dev',
      url: 'http://127.0.0.1:3000/healthz',
      env: { HOST: '127.0.0.1', PORT: '3000' },
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @multi-harness/web dev --port 5173 --strictPort',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: false,
    },
  ],
});
