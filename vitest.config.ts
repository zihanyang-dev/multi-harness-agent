import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['development'],
  },
  test: {
    environment: 'node',
    // Native Pi SDK checks run through native.test.ts in a clean child environment.
    exclude: [...configDefaults.exclude, 'packages/harness/src/pi/session.test.ts'],
    include: [
      'apps/**/src/**/*.test.ts',
      'packages/**/src/**/*.test.ts',
      'packages/**/tests/**/*.test.ts',
    ],
  },
});
