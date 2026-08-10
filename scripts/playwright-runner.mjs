import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { withRepositoryPlaywrightCache } from './playwright-cache.mjs';

const environment = withRepositoryPlaywrightCache(process.env);
delete environment['FORCE_COLOR'];
delete environment['NO_COLOR'];

const result = spawnSync(
  process.execPath,
  [resolve('node_modules', '@playwright', 'test', 'cli.js'), 'test'],
  {
    env: environment,
    stdio: 'inherit',
  },
);

process.exit(result.status ?? 1);
