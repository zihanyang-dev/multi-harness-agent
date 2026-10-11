import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

it('runs the native Pi suite without ambient credentials or user configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mha-pi-offline-'));
  const config = join(root, 'vitest.config.mts');
  const report = join(root, 'results.json');
  const vitest = join(
    dirname(fileURLToPath(import.meta.resolve('vitest/package.json'))),
    'vitest.mjs',
  );

  try {
    // Select only the SDK cases; importing the root config would launch this wrapper again.
    await writeFile(
      config,
      `export default ${JSON.stringify({
        root: process.cwd(),
        resolve: { conditions: ['development'] },
        test: { environment: 'node', include: ['apps/worker/src/harness/pi/host.sdk.test.ts'] },
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
        // SDK provider registration can inspect ambient configuration even with in-memory stores.
        env: {
          PATH: process.env.PATH,
          HOME: root,
          XDG_CONFIG_HOME: root,
          PI_CODING_AGENT_DIR: root,
          PI_OFFLINE: '1',
          MHA_PI_HOST_FIXTURE: '1',
          NO_COLOR: '1',
        },
        timeout: 30_000,
      },
    ).catch((error: unknown) => {
      if (error instanceof Error && 'stdout' in error && 'stderr' in error)
        throw new Error(`${error.stdout}\n${error.stderr}`, { cause: error });
      throw error;
    });
    const results = JSON.parse(await readFile(report, 'utf8'));
    expect(results.success).toBe(true);
    expect(results.numFailedTests).toBe(0);
    expect(results.numPassedTests).toBe(6);
    console.info(`Pi SDK: ${results.numPassedTests} checks passed in the isolated process.`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);
