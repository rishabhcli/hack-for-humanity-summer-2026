import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { assertBuildPathsSafe, sourceArtifactDigest } from './dev/lib.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const distributionRoot = join(repositoryRoot, 'dist');
const outputPath = join(repositoryRoot, 'evidence', 'tier-0', 'build-reproducibility.json');
const viteEntry = join(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const seed = 'not-applicable-deterministic-vite-build';

/** @returns {NodeJS.ProcessEnv} */
function buildEnvironment() {
  const inherited = Object.fromEntries(
    ['HOME', 'LANG', 'LC_ALL', 'NO_COLOR', 'PATH', 'TMPDIR'].flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
  return { ...inherited, NODE_ENV: 'production' };
}

/** @returns {void} */
function runBuild() {
  assertBuildPathsSafe();
  execFileSync(process.execPath, [viteEntry, 'build'], {
    cwd: repositoryRoot,
    env: buildEnvironment(),
    stdio: 'inherit',
  });
}

/** @returns {{files: Array<{bytes: number, path: string, sha256: string}>, totalBytes: number}} */
function buildManifest() {
  if (!existsSync(distributionRoot) || lstatSync(distributionRoot).isSymbolicLink()) {
    throw new Error('BUILD_ARTIFACT_DIRECTORY_INVALID path=dist');
  }
  /** @type {Array<{bytes: number, path: string, sha256: string}>} */
  const files = [];

  /** @param {string} directory @returns {void} */
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`BUILD_ARTIFACT_SYMLINK_REFUSED path=${relative(repositoryRoot, path)}`);
      }
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`BUILD_ARTIFACT_FILE_TYPE_REFUSED path=${relative(repositoryRoot, path)}`);
      }
      const contents = readFileSync(path);
      const text = contents.toString('utf8');
      if (
        text.includes(repositoryRoot) ||
        /(?:file:\/\/\/|\/(?:Users|home|root)\/|\/private\/var\/folders\/|[A-Za-z]:\\Users\\)/u.test(
          text,
        )
      ) {
        throw new Error(`BUILD_ARTIFACT_HOST_PATH_LEAK path=${relative(repositoryRoot, path)}`);
      }
      files.push({
        bytes: contents.byteLength,
        path: relative(distributionRoot, path),
        sha256: createHash('sha256').update(contents).digest('hex'),
      });
    }
  }

  visit(distributionRoot);
  return {
    files,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
  };
}

runBuild();
const first = buildManifest();
runBuild();
const second = buildManifest();
if (JSON.stringify(first) !== JSON.stringify(second)) {
  throw new Error('BUILD_ARTIFACT_NOT_REPRODUCIBLE');
}

const evidence = {
  command: 'npm run evidence:build',
  fileCount: second.files.length,
  files: second.files,
  lockfileSha256: createHash('sha256')
    .update(readFileSync(join(repositoryRoot, 'package-lock.json')))
    .digest('hex'),
  manifestSha256: createHash('sha256').update(JSON.stringify(second.files)).digest('hex'),
  platformScope: 'platform-neutral-static-web-artifact',
  referenceNodeVersion: readFileSync(join(repositoryRoot, '.node-version'), 'utf8').trim(),
  referenceNpmVersion: '11.17.0',
  seed,
  sourceInputDigest: sourceArtifactDigest(),
  totalBytes: second.totalBytes,
};
const serialized = `${JSON.stringify(evidence, null, 2)}\n`;

if (process.argv.includes('--write')) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized, 'utf8');
  console.log(
    `build-reproducibility generated files=${String(evidence.fileCount)} bytes=${String(evidence.totalBytes)} digest=${evidence.manifestSha256}`,
  );
} else {
  if (!existsSync(outputPath) || readFileSync(outputPath, 'utf8') !== serialized) {
    throw new Error('BUILD_REPRODUCIBILITY_EVIDENCE_STALE run="npm run evidence:build"');
  }
  console.log(
    `build-reproducibility current files=${String(evidence.fileCount)} bytes=${String(evidence.totalBytes)} digest=${evidence.manifestSha256}`,
  );
}
