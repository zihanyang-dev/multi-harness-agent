import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { expect, it } from 'vitest';

it('keeps application business out of shared packages', async () => {
  expect(existsSync('packages/conversations')).toBe(false);
  const packages = ['database', 'protocol', 'harness', 'sandbox'];
  for (const name of packages) {
    const manifest = JSON.parse(await readFile(`packages/${name}/package.json`, 'utf8'));
    const dependencies = Object.keys(manifest.dependencies ?? {});
    expect(
      dependencies.some(
        (dependency) =>
          dependency === '@multi-harness/server' || dependency === '@multi-harness/worker',
      ),
    ).toBe(false);
    if (name === 'database') expect(dependencies).not.toContain('@multi-harness/protocol');
  }
});

it('keeps product and execution processes independently consumable', async () => {
  for (const [application, forbidden] of [
    ['server', 'worker'],
    ['worker', 'server'],
  ]) {
    const manifest = JSON.parse(await readFile(`apps/${application}/package.json`, 'utf8'));
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain(`@multi-harness/${forbidden}`);
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain('@multi-harness/conversations');
  }
});

it('prevents production source from crossing application ownership', async () => {
  for (const [application, forbidden] of [
    ['server', 'worker'],
    ['worker', 'server'],
  ] as const) {
    for (const { file, target } of await productionImports(`apps/${application}/src`)) {
      expect(crossesApplicationBoundary(file, target, forbidden), file).toBe(false);
    }
  }
});

it('guards application roots, private subpaths and relative imports without prefix false positives', () => {
  for (const forbidden of ['server', 'worker'] as const) {
    const application = forbidden === 'server' ? 'worker' : 'server';
    const file = `apps/${application}/src/main.ts`;
    const packageName = `@multi-harness/${forbidden}`;
    expect(crossesApplicationBoundary(file, packageName, forbidden)).toBe(true);
    expect(crossesApplicationBoundary(file, `${packageName}/src/private.js`, forbidden)).toBe(true);
    expect(crossesApplicationBoundary(file, `${packageName}-utilities`, forbidden)).toBe(false);
    expect(crossesApplicationBoundary(file, `../../${forbidden}/src/private.js`, forbidden)).toBe(
      true,
    );
    expect(crossesApplicationBoundary(file, './config.js', forbidden)).toBe(false);
  }
});

it('keeps database source independent of product protocols and application code', async () => {
  for (const { file, target } of await productionImports('packages/database/src')) {
    expect(target.startsWith('@multi-harness/protocol'), file).toBe(false);
    if (target.startsWith('.'))
      expect(resolve(dirname(file), target).startsWith(`${resolve('apps')}/`), file).toBe(false);
  }
});

function crossesApplicationBoundary(
  file: string,
  target: string,
  forbidden: 'server' | 'worker',
): boolean {
  const packageName = `@multi-harness/${forbidden}`;
  if (target === packageName || target.startsWith(`${packageName}/`)) return true;
  return (
    target.startsWith('.') &&
    resolve(dirname(file), target).startsWith(`${resolve('apps', forbidden)}/`)
  );
}

async function productionImports(
  directory: string,
): Promise<Array<{ file: string; target: string }>> {
  const imports: Array<{ file: string; target: string }> = [];
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || /\.test(?:-d)?\.ts$/.test(entry.name))
      continue;
    const file = join(entry.parentPath, entry.name);
    const source = await readFile(file, 'utf8');
    // Covers static imports/exports and literal dynamic imports, including private subpaths.
    for (const [, target] of source.matchAll(
      /\b(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g,
    )) {
      if (target !== undefined) imports.push({ file, target });
    }
  }
  return imports;
}
