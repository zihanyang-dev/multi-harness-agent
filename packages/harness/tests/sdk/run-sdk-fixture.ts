import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/** Runs a real SDK with test-only transport/model fixtures and an isolated user environment. */
export async function runSdkFixture(name: 'pi' | 'openai' | 'claude'): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'harness-sdk-fixture-'));
  try {
    const { stdout } = await execute(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL(`./${fixtureFiles[name]}`, import.meta.url)),
      ],
      {
        cwd: home,
        encoding: 'utf8',
        timeout: 20_000,
        killSignal: 'SIGKILL',
        maxBuffer: 2 * 1024 * 1024,
        env: {
          HOME: home,
          PATH: process.env.PATH ?? '',
          XDG_CONFIG_HOME: join(home, 'config'),
          XDG_CACHE_HOME: join(home, 'cache'),
          XDG_STATE_HOME: join(home, 'state'),
          PI_CODING_AGENT_DIR: join(home, 'pi'),
          PI_OFFLINE: '1',
          NO_COLOR: '1',
          TERM: 'dumb',
        },
      },
    );
    return stdout;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const execute = promisify(execFile);
const fixtureFiles = {
  pi: 'pi-session.fixture.ts',
  openai: 'openai-responses.fixture.ts',
  claude: 'claude-stdin.fixture.ts',
};
