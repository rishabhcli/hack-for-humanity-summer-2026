import { spawnSync } from 'node:child_process';

import { withRepositoryNpmCache } from './npm-environment.mjs';

const npmEnvironment = withRepositoryNpmCache(process.env);

const steps = [
  'format',
  'lint',
  'check:dependencies',
  'audit:dependencies',
  'typecheck',
  'test',
  'build',
  'check:build',
  'test-integration',
  'dev:preflight',
  'dev:health',
  'test:e2e:runner',
];

for (const step of steps) {
  console.log(`verify-all start step=${step}`);
  const result = spawnSync('npm', ['run', step], {
    encoding: 'utf8',
    env: npmEnvironment,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error(`verify-all failed step=${step} exit=${String(result.status)}`);
    process.exit(result.status ?? 1);
  }
}

console.log(`verify-all passed steps=${steps.length}`);
