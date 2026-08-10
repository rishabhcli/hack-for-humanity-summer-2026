import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEV_ROOT, ensureDevDirectories } from './dev/lib.mjs';
import { checkSourceBoundaries } from './boundary-checker.mjs';

ensureDevDirectories();
const fixtureRoot = resolve(DEV_ROOT, 'tmp', `boundary-${process.pid}-${randomUUID()}`);

/** @param {Record<string, string>} files @returns {ReturnType<typeof checkSourceBoundaries>} */
function checkFixture(files) {
  const sourceRoot = resolve(fixtureRoot, 'src');
  for (const [path, contents] of Object.entries(files)) {
    const target = resolve(sourceRoot, path);
    mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, contents, 'utf8');
  }
  return checkSourceBoundaries(sourceRoot, fixtureRoot);
}

afterEach(() => rmSync(fixtureRoot, { force: true, recursive: true }));

describe('source-tree boundary scanner', () => {
  it('walks a valid owned composition without a violation', () => {
    const result = checkFixture({
      'main.ts': "import './ui-accessibility/surface';\n",
      'ui-accessibility/surface.ts': 'export const surface = true;\n',
    });
    expect(result.violations).toEqual([]);
    expect(result.filesChecked).toBe(2);
  });

  it('rejects unowned source paths discovered by traversal', () => {
    const result = checkFixture({ 'utils/parser.ts': 'export const unsafe = true;\n' });
    expect(result.violations.join('\n')).toContain('outside an owned area');
  });

  it.each(['tsx', 'mts', 'cts'])('rejects an unowned .%s source path', (extension) => {
    const result = checkFixture({ [`unowned/escape.${extension}`]: 'export const x = true;\n' });
    expect(result.violations.join('\n')).toContain('outside an owned area');
  });

  it('rejects static, dynamic, require, and UI imports from a domain area', () => {
    const result = checkFixture({
      'measurement/error.ts': [
        "import '../ui-accessibility/surface';",
        "import 'unreviewed-package';",
        "void import('another-package');",
        "require('runtime-package');",
      ].join('\n'),
      'ui-accessibility/surface.ts': 'export const surface = true;\n',
    });
    const output = result.violations.join('\n');
    expect(output).toContain('non-domain local area ui-accessibility');
    expect(output).toContain('non-allowlisted external package unreviewed-package');
    expect(output).toContain('non-allowlisted external package another-package');
    expect(output).toContain('non-allowlisted external package runtime-package');
  });

  it('rejects a circular local dependency', () => {
    const result = checkFixture({
      'measurement/a.ts': "import './b';\nexport const a = true;\n",
      'measurement/b.ts': "import './a';\nexport const b = true;\n",
    });
    expect(result.violations.join('\n')).toContain('circular dependency');
  });

  it('rejects a production import of a test-only module', () => {
    const result = checkFixture({
      'main.ts': "import './ui-accessibility/hidden.test';\n",
      'ui-accessibility/hidden.test.ts': "import 'test-only-dependency';\n",
    });
    expect(result.violations.join('\n')).toContain('production import reaches test-only module');
  });

  it('discovers import-type edges and cycles', () => {
    const result = checkFixture({
      'measurement/a.ts':
        "export type A = import('../ui-accessibility/surface').Surface;\nexport type B = import('./b').B;\n",
      'measurement/b.ts': "export type B = import('./a').A;\n",
      'ui-accessibility/surface.ts': 'export type Surface = true;\n',
    });
    const output = result.violations.join('\n');
    expect(output).toContain('non-domain local area ui-accessibility');
    expect(output).toContain('circular dependency');
  });

  it('rejects non-literal dynamic import and require calls', () => {
    const result = checkFixture({
      'measurement/loader.ts':
        'declare const target: string;\nvoid import(target);\ndeclare function require(value: string): unknown;\nrequire(target);\n',
    });
    expect(
      result.violations.filter((violation) => violation.includes('non-literal module load')),
    ).toHaveLength(2);
  });
});
