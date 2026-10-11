import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['development'] },
  test: {
    environment: 'node',
    // Native auth scans pg_catalog; another file dropping a schema can invalidate that scan.
    // Explicit concurrency cases inside each suite still exercise competing transactions.
    fileParallelism: false,
    include: ['apps/**/src/**/*.integration.test.ts', 'tests/integration/**/*.integration.test.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
