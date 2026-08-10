import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { REPOSITORY_ROOT, assertBuildPathsSafe } from './dev/lib.mjs';

const inheritedEnvironment = Object.fromEntries(
  ['HOME', 'LANG', 'LC_ALL', 'NO_COLOR', 'PATH', 'TMPDIR'].flatMap((key) => {
    const value = process.env[key];
    return value === undefined ? [] : [[key, value]];
  }),
);

assertBuildPathsSafe();
execFileSync(
  process.execPath,
  [join(REPOSITORY_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'],
  {
    cwd: REPOSITORY_ROOT,
    env: { ...inheritedEnvironment, NODE_ENV: 'production' },
    stdio: 'inherit',
  },
);
