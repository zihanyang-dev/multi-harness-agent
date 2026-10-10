import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['development'],
  },
  test: {
    environment: 'node',
    // Pi session.test.ts owns the clean child process that executes session.sdk.test.ts.
    exclude: [...configDefaults.exclude, 'packages/harness/src/pi/session.sdk.test.ts'],
    include: [
      'apps/**/src/**/*.test.ts',
      'packages/**/src/**/*.test.ts',
      'packages/**/tests/**/*.test.ts',
    ],
  },
});
