import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import {
  CACHE_ROOT,
  REPOSITORY_ROOT,
  assertBuildPathsSafe,
  controlPlaneDigest,
  directoryDigest,
  ensureDevDirectories,
  sha256,
  sourceArtifactDigest,
} from './lib.mjs';
import { withRepositoryNpmCache } from '../npm-environment.mjs';

const BUILD_PROVENANCE_PATH = join(CACHE_ROOT, 'build-provenance.json');
const BUILD_COMMAND = 'npm run build';
const BUILD_SCHEMA_VERSION = 1;

/** @returns {NodeJS.ProcessEnv} */
function buildEnvironment() {
  const inherited = Object.fromEntries(
    ['HOME', 'LANG', 'LC_ALL', 'NO_COLOR', 'PATH', 'TMPDIR'].flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
  return withRepositoryNpmCache(inherited);
}

/** @returns {string} */
function expectedBuildInputDigest() {
  return sha256(
    [
      sourceArtifactDigest(),
      controlPlaneDigest(),
      process.version,
      BUILD_COMMAND,
      String(BUILD_SCHEMA_VERSION),
    ].join('\n'),
  );
}

/** @returns {{buildCommand: string, inputDigest: string, nodeVersion: string, outputDigest: string, schemaVersion: number} | null} */
function readBuildProvenance() {
  if (!existsSync(BUILD_PROVENANCE_PATH)) {
    return null;
  }
  const metadata = lstatSync(BUILD_PROVENANCE_PATH);
  const realPath = realpathSync(BUILD_PROVENANCE_PATH);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    !realPath.startsWith(`${resolve(CACHE_ROOT)}/`)
  ) {
    throw new Error('BUILD_PROVENANCE_PATH_REFUSED');
  }
  let descriptor;
  try {
    descriptor = openSync(BUILD_PROVENANCE_PATH, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    if (!fstatSync(descriptor).isFile()) {
      throw new Error('BUILD_PROVENANCE_PATH_REFUSED');
    }
    const candidate = JSON.parse(readFileSync(descriptor, 'utf8'));
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      Object.keys(candidate).sort().join(',') !==
        'buildCommand,inputDigest,nodeVersion,outputDigest,schemaVersion' ||
      candidate.buildCommand !== BUILD_COMMAND ||
      typeof candidate.inputDigest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(candidate.inputDigest) ||
      candidate.nodeVersion !== process.version ||
      typeof candidate.outputDigest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(candidate.outputDigest) ||
      candidate.schemaVersion !== BUILD_SCHEMA_VERSION
    ) {
      return null;
    }
    return candidate;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

/** @param {ReturnType<typeof readBuildProvenance>} record @returns {void} */
function writeBuildProvenance(record) {
  if (record === null) {
    throw new Error('BUILD_PROVENANCE_WRITE_INVALID');
  }
  const temporaryPath = `${BUILD_PROVENANCE_PATH}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  renameSync(temporaryPath, BUILD_PROVENANCE_PATH);
}

/** @returns {string} */
export function recordCurrentBuildProvenance() {
  ensureDevDirectories();
  assertBuildPathsSafe();
  const outputDigest = directoryDigest(join(REPOSITORY_ROOT, 'dist'));
  writeBuildProvenance({
    buildCommand: BUILD_COMMAND,
    inputDigest: expectedBuildInputDigest(),
    nodeVersion: process.version,
    outputDigest,
    schemaVersion: BUILD_SCHEMA_VERSION,
  });
  return outputDigest;
}

/** @returns {void} */
export function ensureCurrentBuild() {
  ensureDevDirectories();
  assertBuildPathsSafe();
  const inputDigest = expectedBuildInputDigest();
  const provenance = readBuildProvenance();
  if (
    provenance !== null &&
    provenance.inputDigest === inputDigest &&
    existsSync(join(REPOSITORY_ROOT, 'dist')) &&
    provenance.outputDigest === directoryDigest(join(REPOSITORY_ROOT, 'dist'))
  ) {
    console.log(`dev:build retained digest=${provenance.outputDigest}`);
    return;
  }

  execFileSync('npm', ['run', 'build'], {
    cwd: REPOSITORY_ROOT,
    env: buildEnvironment(),
    stdio: 'inherit',
  });
  const outputDigest = recordCurrentBuildProvenance();
  console.log(`dev:build generated digest=${outputDigest}`);
}
