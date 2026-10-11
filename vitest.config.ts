import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['development'],
  },
  test: {
    environment: 'node',
    // Native session.test.ts launchers own clean child processes for SDK suites.
    exclude: [
      ...configDefaults.exclude,
      '**/*.integration.test.ts',
      'apps/worker/src/harness/pi/host.sdk.test.ts',
      'apps/worker/src/worker.sdk.test.ts',
      'packages/harness/src/pi/session.sdk.test.ts',
      'packages/harness/src/claude/session.sdk.test.ts',
    ],
    include: [
      'apps/**/src/**/*.test.ts',
      'packages/**/src/**/*.test.ts',
      'packages/**/tests/**/*.test.ts',
      'tests/architecture.test.ts',
      'tests/e2e-config.test.ts',
    ],
  },
});
