import { spawnSync } from 'node:child_process';

import { withRepositoryNpmCache } from './npm-environment.mjs';

const npmEnvironment = withRepositoryNpmCache(process.env);

for (const step of ['dev:up', 'dev:health', 'test:e2e:runner']) {
  const result = spawnSync('npm', ['run', step], {
    env: npmEnvironment,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error(`E2E_STEP_FAILED step=${step} exit=${String(result.status)}`);
    process.exit(result.status ?? 1);
  }
}
