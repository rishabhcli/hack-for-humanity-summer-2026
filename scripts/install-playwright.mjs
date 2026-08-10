import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { REPOSITORY_ROOT, ensureDevDirectories } from './dev/lib.mjs';
import { PLAYWRIGHT_BROWSERS_PATH, withRepositoryPlaywrightCache } from './playwright-cache.mjs';

ensureDevDirectories();
const playwrightCli = resolve(REPOSITORY_ROOT, 'node_modules', 'playwright', 'cli.js');
if (!existsSync(playwrightCli)) {
  console.error('PLAYWRIGHT_PACKAGE_MISSING run="npm ci"');
  process.exit(1);
}

const result = spawnSync(process.execPath, [playwrightCli, 'install', 'chromium'], {
  cwd: REPOSITORY_ROOT,
  env: withRepositoryPlaywrightCache(process.env),
  stdio: 'inherit',
});
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
console.log(`playwright:install complete cache=${PLAYWRIGHT_BROWSERS_PATH}`);
