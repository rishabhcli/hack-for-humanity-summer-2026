import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { withRepositoryNpmCache } from './npm-environment.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const npmEnvironment = withRepositoryNpmCache(process.env);
if (!existsSync(resolve(repositoryRoot, 'package.json'))) {
  console.error('BOOTSTRAP_PACKAGE_BOUNDARY_MISSING');
  process.exit(1);
}

const [nodeMajor, nodeMinor] = process.versions.node
  .split('.')
  .slice(0, 2)
  .map((value) => Number.parseInt(value, 10));
if (
  nodeMajor === undefined ||
  nodeMinor === undefined ||
  nodeMajor < 24 ||
  nodeMajor > 26 ||
  (nodeMajor === 24 && nodeMinor < 19)
) {
  console.error(`BOOTSTRAP_NODE_UNSUPPORTED actual=${process.version} expected=>=24.19.0 <27`);
  process.exit(1);
}

const npmVersionResult = spawnSync('npm', ['--version'], {
  encoding: 'utf8',
  env: npmEnvironment,
});
if (npmVersionResult.status !== 0) {
  console.error('BOOTSTRAP_NPM_MISSING');
  process.exit(1);
}
if (npmVersionResult.stdout.trim() !== '11.17.0') {
  console.error(
    `BOOTSTRAP_NPM_UNSUPPORTED actual=${npmVersionResult.stdout.trim()} expected=11.17.0`,
  );
  process.exit(1);
}

const prefixResult = spawnSync('npm', ['prefix'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  env: npmEnvironment,
});
if (resolve(prefixResult.stdout.trim()) !== repositoryRoot) {
  console.error(
    `BOOTSTRAP_PACKAGE_BOUNDARY_INVALID actual=${prefixResult.stdout.trim()} expected=${repositoryRoot}`,
  );
  process.exit(1);
}

const installResult = spawnSync('npm', ['ci', '--no-fund', '--no-audit'], {
  cwd: repositoryRoot,
  env: npmEnvironment,
  stdio: 'inherit',
});
if (installResult.status !== 0) {
  process.exit(installResult.status ?? 1);
}

const browserInstallResult = spawnSync(
  process.execPath,
  [resolve(repositoryRoot, 'scripts', 'install-playwright.mjs')],
  {
    cwd: repositoryRoot,
    env: npmEnvironment,
    stdio: 'inherit',
  },
);
if (browserInstallResult.status !== 0) {
  process.exit(browserInstallResult.status ?? 1);
}

console.log(`bootstrap complete node=${process.version} npm=${npmVersionResult.stdout.trim()}`);
