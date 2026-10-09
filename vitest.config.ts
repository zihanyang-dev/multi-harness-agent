import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['development'],
  },
  test: {
    environment: 'node',
    include: [
      'apps/**/src/**/*.test.ts',
      'packages/**/src/**/*.test.ts',
      'packages/**/tests/**/*.test.ts',
    ],
  },
});
