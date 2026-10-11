import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

it('executes and resumes native Pi through PostgreSQL outbox and the BullMQ worker in isolation', async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  const redisUrl = process.env.TEST_REDIS_URL;
  if (!databaseUrl || !redisUrl)
    throw new Error('Explicit TEST_DATABASE_URL and TEST_REDIS_URL are required');
  for (const url of [databaseUrl, redisUrl]) {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
      throw new Error('Native integration tests require loopback services');
  }
  const root = await mkdtemp(join(tmpdir(), 'mha-runtime-native-'));
  const config = join(root, 'vitest.config.mts');
  const report = join(root, 'results.json');
  const vitest = join(
    dirname(fileURLToPath(import.meta.resolve('vitest/package.json'))),
    'vitest.mjs',
  );
  try {
    await writeFile(
      config,
      `export default ${JSON.stringify({
        root: process.cwd(),
        resolve: { conditions: ['development'] },
        test: {
          environment: 'node',
          include: ['apps/worker/src/worker.sdk.test.ts'],
          testTimeout: 20000,
          hookTimeout: 15000,
        },
      })};`,
    );
    await promisify(execFile)(
      process.execPath,
      [
        vitest,
        'run',
        '--config',
        config,
        '--reporter=default',
        '--reporter=json',
        '--outputFile',
        report,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          XDG_CONFIG_HOME: root,
          PI_CODING_AGENT_DIR: root,
          PI_OFFLINE: '1',
          MHA_RUNTIME_FIXTURE: '1',
          TEST_DATABASE_URL: databaseUrl,
          TEST_REDIS_URL: redisUrl,
          NO_COLOR: '1',
        },
        timeout: 35000,
      },
    ).catch((error: unknown) => {
      if (error instanceof Error && 'stdout' in error && 'stderr' in error)
        throw new Error(`${error.stdout}\n${error.stderr}`, { cause: error });
      throw error;
    });
    const results = JSON.parse(await readFile(report, 'utf8'));
    expect(results.success).toBe(true);
    expect(results.numFailedTests).toBe(0);
    expect(results.numPassedTests).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
