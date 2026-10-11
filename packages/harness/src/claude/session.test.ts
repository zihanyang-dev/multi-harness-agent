import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

it('runs the native Claude suite with synthetic IO and no ambient credentials or configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mha-claude-offline-'));
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
        test: { environment: 'node', include: ['packages/harness/src/claude/session.sdk.test.ts'] },
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
          CLAUDE_CONFIG_DIR: root,
          MHA_CLAUDE_OFFLINE: '1',
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
    console.info(`Claude SDK: ${results.numPassedTests} checks passed in the isolated process.`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);
