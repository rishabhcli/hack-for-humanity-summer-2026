import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { withRepositoryNpmCache } from './npm-environment.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const npmEnvironment = withRepositoryNpmCache(process.env);

/** @param {string[]} args @returns {string} */
function gitOutput(args) {
  const result = spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`EVIDENCE_GIT_INSPECTION_FAILED args=${args.join(' ')}`);
  }
  return result.stdout.trim();
}

const statusAtStart = gitOutput(['status', '--porcelain=v1', '--untracked-files=all']);
if (statusAtStart !== '') {
  console.error('EVIDENCE_CAPTURE_REFUSED code=WORKTREE_NOT_CLEAN');
  process.exit(2);
}

const verifiedCommit = gitOutput(['rev-parse', 'HEAD']);
const verifiedTree = gitOutput(['rev-parse', 'HEAD^{tree}']);
const npmVersionResult = spawnSync('npm', ['--version'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  env: npmEnvironment,
});
if (npmVersionResult.status !== 0) {
  console.error('EVIDENCE_CAPTURE_REFUSED code=NPM_VERSION_UNAVAILABLE');
  process.exit(2);
}

const result = spawnSync('npm', ['run', 'verify-all'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  env: npmEnvironment,
  maxBuffer: 20 * 1024 * 1024,
});
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
process.stdout.write(output);

const evidencePath = resolve(repositoryRoot, 'evidence', 'tier-0', 'verify-all-local.log');
mkdirSync(dirname(evidencePath), { recursive: true });
writeFileSync(
  evidencePath,
  `# command: npm run evidence:verify\n` +
    `# underlying-command: npm run verify-all\n` +
    `# seed: 20260809\n` +
    `# verified-commit: ${verifiedCommit}\n` +
    `# verified-tree: ${verifiedTree}\n` +
    `# clean-at-start: true\n` +
    `# started-at: ${new Date().toISOString()}\n` +
    `# node: ${process.version}\n` +
    `# npm: ${npmVersionResult.stdout.trim()}\n` +
    `# platform: ${process.platform}-${process.arch}\n` +
    `# result: ${result.status === 0 ? 'passed' : 'failed'}\n` +
    `\n${output}`,
  'utf8',
);

process.exit(result.status ?? 1);
