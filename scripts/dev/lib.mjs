import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPOSITORY_NPM_CACHE, withRepositoryNpmCache } from '../npm-environment.mjs';

export const REPOSITORY_NAME = 'hack-for-humanity-summer-2026';
export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEV_ROOT = join(REPOSITORY_ROOT, '.dev');
export const CACHE_ROOT = join(DEV_ROOT, 'cache');
export const PLAYWRIGHT_BROWSER_CACHE_PATH = join(CACHE_ROOT, 'ms-playwright');
export const CERTIFICATE_PATH = join(DEV_ROOT, 'certs', 'localhost.pem');
export const CERTIFICATE_KEY_PATH = join(DEV_ROOT, 'certs', 'localhost-key.pem');

const PORT_ENV_PATH = join(REPOSITORY_ROOT, 'ports.env');
const PID_ROOT = join(DEV_ROOT, 'pids');
const LOG_ROOT = join(DEV_ROOT, 'logs');
const LIFECYCLE_LOCK_PATH = join(PID_ROOT, 'lifecycle.lock');
const REQUIRED_PORT_KEYS = ['PORT_0', 'PORT_1', 'PORT_2', 'PORT_3'];
const ALLOWED_PORT_MIN = 4180;
const ALLOWED_PORT_MAX = 4189;
const REQUIRED_NODE_MAJOR_MIN = 24;
const REQUIRED_NODE_MAJOR_MAX = 26;
const REQUIRED_NODE_24_MINOR_MIN = 19;
const LOCK_SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/** @typedef {'pwa' | 'preview' | 'playwright' | 'fixtures'} ServiceId */
/**
 * @typedef Ports
 * @property {number} PORT_0
 * @property {number} PORT_1
 * @property {number} PORT_2
 * @property {number} PORT_3
 */
/**
 * @typedef ServiceDefinition
 * @property {ServiceId} id
 * @property {string} label
 * @property {number} port
 */
/**
 * @typedef PidRecord
 * @property {string} artifactDigest
 * @property {string} certificateDigest
 * @property {string} configDigest
 * @property {string} host
 * @property {string} ownershipToken
 * @property {number} pid
 * @property {number} port
 * @property {string} processCommand
 * @property {string} processStart
 * @property {string} readinessSecret
 * @property {string} repositoryRoot
 * @property {string} runId
 * @property {number} schemaVersion
 * @property {ServiceId} service
 * @property {string} startedAt
 */
/**
 * @typedef ReadinessFields
 * @property {string} artifactDigest
 * @property {string} certificateDigest
 * @property {string} challenge
 * @property {string} configDigest
 * @property {number} pid
 * @property {number} port
 * @property {string} runId
 * @property {ServiceId} service
 */
/**
 * @typedef ReadinessPayload
 * @property {string} artifactDigest
 * @property {string} certificateDigest
 * @property {string} configDigest
 * @property {string} host
 * @property {number} pid
 * @property {number} port
 * @property {string} repository
 * @property {string} runId
 * @property {ServiceId} service
 * @property {string} signature
 * @property {'ready'} status
 */

export const DEV_DIRECTORIES = [
  DEV_ROOT,
  CACHE_ROOT,
  join(DEV_ROOT, 'certs'),
  LOG_ROOT,
  PID_ROOT,
  join(DEV_ROOT, 'pw-profile'),
  join(DEV_ROOT, 'tmp'),
];

/** @param {string} contents @returns {Readonly<Ports>} */
export function parsePortsEnv(contents) {
  /** @type {Map<string, number>} */
  const parsed = new Map();

  for (const [index, rawLine] of contents.split(/\r?\n/u).entries()) {
    const line = rawLine.replace(/\s+#.*$/u, '').trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const match = /^(PORT_[0-9]+)=([0-9]+)$/u.exec(line);
    if (match === null) {
      throw new Error(`PORT_CONFIG_INVALID line=${index + 1}`);
    }

    const [, key, rawPort] = match;
    if (key === undefined || rawPort === undefined) {
      throw new Error(`PORT_CONFIG_INVALID line=${index + 1}`);
    }
    if (parsed.has(key)) {
      throw new Error(`PORT_CONFIG_DUPLICATE key=${key}`);
    }

    const port = Number.parseInt(rawPort, 10);
    if (!Number.isSafeInteger(port) || port < ALLOWED_PORT_MIN || port > ALLOWED_PORT_MAX) {
      throw new Error(`PORT_CONFIG_OUT_OF_BLOCK key=${key} port=${rawPort}`);
    }
    parsed.set(key, port);
  }

  for (const key of REQUIRED_PORT_KEYS) {
    if (!parsed.has(key)) {
      throw new Error(`PORT_CONFIG_MISSING key=${key}`);
    }
  }
  for (const key of parsed.keys()) {
    if (!REQUIRED_PORT_KEYS.includes(key)) {
      throw new Error(`PORT_CONFIG_UNKNOWN key=${key}`);
    }
  }

  const requiredPorts = REQUIRED_PORT_KEYS.map((key) => parsed.get(key));
  if (new Set(requiredPorts).size !== requiredPorts.length) {
    throw new Error('PORT_CONFIG_COLLISION');
  }

  return Object.freeze(/** @type {Ports} */ (Object.fromEntries(parsed)));
}

/** @returns {Readonly<Ports>} */
export function readPorts() {
  if (!existsSync(PORT_ENV_PATH)) {
    throw new Error(`PORT_CONFIG_MISSING path=${PORT_ENV_PATH}`);
  }
  assertRegularRepositoryFile(PORT_ENV_PATH, 'PORT_CONFIG_FILE_INVALID');
  return parsePortsEnv(readRepositoryFile(PORT_ENV_PATH, 'PORT_CONFIG_FILE_INVALID').toString());
}

/** @param {Readonly<Ports>} [ports] @returns {ServiceDefinition[]} */
export function serviceDefinitions(ports = readPorts()) {
  return [
    {
      id: 'pwa',
      label: 'Vite PWA development server',
      port: ports.PORT_0,
    },
    {
      id: 'preview',
      label: 'HTTPS production preview',
      port: ports.PORT_1,
    },
    {
      id: 'playwright',
      label: 'Playwright webServer',
      port: ports.PORT_2,
    },
    {
      id: 'fixtures',
      label: 'Known-angle fixture server',
      port: ports.PORT_3,
    },
  ];
}

/**
 * @param {ServiceDefinition} definition
 * @returns {{args: string[], command: string, environment: Readonly<Record<string, string>>}}
 */
export function serviceCommand(definition) {
  const viteEntry = join(REPOSITORY_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (definition.id === 'fixtures') {
    return {
      args: [
        join(REPOSITORY_ROOT, 'scripts', 'dev', 'fixture-server.mjs'),
        '--port',
        String(definition.port),
      ],
      command: process.execPath,
      environment: Object.freeze({ NODE_ENV: 'development' }),
    };
  }

  if (definition.id === 'preview' || definition.id === 'playwright') {
    return {
      args: [
        viteEntry,
        'preview',
        '--host',
        '127.0.0.1',
        '--port',
        String(definition.port),
        '--strictPort',
      ],
      command: process.execPath,
      environment: Object.freeze({ NODE_ENV: 'production' }),
    };
  }

  return {
    args: [
      viteEntry,
      '--host',
      '127.0.0.1',
      '--port',
      String(definition.port),
      '--strictPort',
      '--mode',
      'development',
    ],
    command: process.execPath,
    environment: Object.freeze({ NODE_ENV: 'development' }),
  };
}

/** @param {ServiceDefinition} definition @returns {string} */
export function expectedProcessCommand(definition) {
  const launch = serviceCommand(definition);
  return [launch.command, ...launch.args].join(' ');
}

/** @param {string | Buffer} value @returns {string} */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {string} path @returns {string} */
export function fileDigest(path) {
  assertRegularRepositoryFile(path, 'DIGEST_FILE_INVALID');
  return sha256(readRepositoryFile(path, 'DIGEST_FILE_INVALID'));
}

/** @param {string} directory @returns {string} */
export function directoryDigest(directory) {
  assertRepositoryDirectory(directory, 'DIGEST_DIRECTORY_INVALID');
  const digest = createHash('sha256');

  /** @param {string} currentDirectory @returns {void} */
  function visit(currentDirectory) {
    for (const entry of readdirSync(currentDirectory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(currentDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`DIGEST_SYMLINK_REFUSED path=${relativePath(path)}`);
      }
      if (entry.isDirectory()) {
        assertRepositoryDirectory(path, 'DIGEST_DIRECTORY_INVALID');
        visit(path);
      } else if (entry.isFile()) {
        assertRegularRepositoryFile(path, 'DIGEST_FILE_INVALID');
        digest.update(relativePath(path));
        digest.update('\0');
        digest.update(readRepositoryFile(path, 'DIGEST_FILE_INVALID'));
        digest.update('\0');
      } else {
        throw new Error(`DIGEST_FILE_TYPE_REFUSED path=${relativePath(path)}`);
      }
    }
  }

  visit(directory);
  return digest.digest('hex');
}

/** @param {string} path @returns {string} */
function relativePath(path) {
  return path.slice(REPOSITORY_ROOT.length + 1);
}

/** @param {string} path @returns {boolean} */
function isInsideRepository(path) {
  const resolvedPath = resolve(path);
  return resolvedPath === REPOSITORY_ROOT || resolvedPath.startsWith(`${REPOSITORY_ROOT}/`);
}

/** @param {string} path @param {string} code @returns {void} */
function assertRegularRepositoryFile(path, code) {
  if (!isInsideRepository(path)) {
    throw new Error(`${code} reason=outside-repository path=${path}`);
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${code} reason=not-regular-file path=${relativePath(path)}`);
  }
  const realPath = realpathSync(path);
  if (!isInsideRepository(realPath)) {
    throw new Error(`${code} reason=realpath-escape path=${relativePath(path)}`);
  }
}

/** @param {string} path @param {string} code @returns {void} */
function assertRepositoryDirectory(path, code) {
  if (!isInsideRepository(path)) {
    throw new Error(`${code} reason=outside-repository path=${path}`);
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${code} reason=not-directory path=${relativePath(path)}`);
  }
  const realPath = realpathSync(path);
  if (!isInsideRepository(realPath)) {
    throw new Error(`${code} reason=realpath-escape path=${relativePath(path)}`);
  }
}

/** @param {string} path @param {string} code @returns {Buffer} */
function readRepositoryFile(path, code) {
  assertRegularRepositoryFile(path, code);
  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${code} reason=open-refused path=${relativePath(path)}`, { cause: error });
  }
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`${code} reason=descriptor-not-regular path=${relativePath(path)}`);
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function configurationDigest() {
  return sha256(
    JSON.stringify({
      host: '127.0.0.1',
      ports: readPorts(),
      repository: REPOSITORY_NAME,
    }),
  );
}

/** @returns {string} */
export function controlPlaneDigest() {
  return sha256(
    [
      directoryDigest(join(REPOSITORY_ROOT, 'scripts', 'dev')),
      fileDigest(join(REPOSITORY_ROOT, 'playwright.config.ts')),
      fileDigest(join(REPOSITORY_ROOT, 'ports.env')),
      fileDigest(join(REPOSITORY_ROOT, 'vite.config.ts')),
    ].join('\n'),
  );
}

/** @returns {string} */
export function sourceArtifactDigest() {
  const semanticFiles = [
    '.node-version',
    '.npmrc',
    'index.html',
    'package-lock.json',
    'package.json',
    'scripts/assert-build-paths.mjs',
    'scripts/run-vite-build.mjs',
    'tsconfig.json',
    'tsconfig.scripts.json',
    'tsconfig.tools.json',
    'vite.config.ts',
  ];
  return sha256(
    [
      directoryDigest(join(REPOSITORY_ROOT, 'src')),
      ...semanticFiles.map((path) => fileDigest(join(REPOSITORY_ROOT, path))),
    ].join('\n'),
  );
}

/** @param {ServiceDefinition} definition @returns {string} */
export function desiredArtifactDigest(definition) {
  let serviceContentDigest;
  if (definition.id === 'fixtures') {
    serviceContentDigest = fileDigest(
      join(REPOSITORY_ROOT, 'validation', 'fixtures', 'manifest.v1.json'),
    );
  } else if (definition.id === 'pwa') {
    serviceContentDigest = sourceArtifactDigest();
  } else {
    serviceContentDigest = directoryDigest(join(REPOSITORY_ROOT, 'dist'));
  }
  return sha256([definition.id, serviceContentDigest, controlPlaneDigest()].join('\n'));
}

/** @returns {void} */
export function assertBuildPathsSafe() {
  const environmentFiles = readdirSync(REPOSITORY_ROOT).filter(
    (entry) => entry === '.env' || entry.startsWith('.env.'),
  );
  if (environmentFiles.length > 0) {
    throw new Error(`BUILD_ENV_FILE_REFUSED files=${environmentFiles.sort().join(',')}`);
  }
  for (const path of [
    join(REPOSITORY_ROOT, '.node-version'),
    join(REPOSITORY_ROOT, '.npmrc'),
    join(REPOSITORY_ROOT, 'index.html'),
    join(REPOSITORY_ROOT, 'package-lock.json'),
    join(REPOSITORY_ROOT, 'package.json'),
    join(REPOSITORY_ROOT, 'playwright.config.ts'),
    join(REPOSITORY_ROOT, 'ports.env'),
    join(REPOSITORY_ROOT, 'scripts', 'assert-build-paths.mjs'),
    join(REPOSITORY_ROOT, 'scripts', 'run-vite-build.mjs'),
    join(REPOSITORY_ROOT, 'tsconfig.json'),
    join(REPOSITORY_ROOT, 'tsconfig.scripts.json'),
    join(REPOSITORY_ROOT, 'tsconfig.tools.json'),
    join(REPOSITORY_ROOT, 'validation', 'fixtures', 'manifest.v1.json'),
    join(REPOSITORY_ROOT, 'vite.config.ts'),
  ]) {
    fileDigest(path);
  }
  directoryDigest(join(REPOSITORY_ROOT, 'scripts', 'dev'));
  directoryDigest(join(REPOSITORY_ROOT, 'src'));
  const distributionPath = join(REPOSITORY_ROOT, 'dist');
  if (existsSync(distributionPath)) {
    directoryDigest(distributionPath);
  }
}

/** @param {ReadinessFields} fields @returns {string} */
export function readinessMessage({
  artifactDigest,
  certificateDigest,
  challenge,
  configDigest,
  pid,
  port,
  runId,
  service,
}) {
  return [
    challenge,
    REPOSITORY_NAME,
    service,
    '127.0.0.1',
    String(port),
    String(pid),
    runId,
    configDigest,
    artifactDigest,
    certificateDigest,
  ].join('\n');
}

/** @param {string} secret @param {ReadinessFields} fields @returns {string} */
export function readinessSignature(secret, fields) {
  return createHmac('sha256', secret).update(readinessMessage(fields)).digest('hex');
}

export function createRunIdentity() {
  return {
    ownershipToken: randomBytes(32).toString('hex'),
    readinessSecret: randomBytes(32).toString('hex'),
    runId: randomUUID(),
  };
}

export function ensureDevDirectories() {
  if (existsSync(DEV_ROOT) && lstatSync(DEV_ROOT).isSymbolicLink()) {
    throw new Error('DEV_DIRECTORY_SYMLINK_REFUSED path=.dev/');
  }
  for (const directory of DEV_DIRECTORIES) {
    mkdirSync(directory, { recursive: true });
    const resolvedDirectory = realpathSync(directory);
    if (
      resolvedDirectory !== realpathSync(DEV_ROOT) &&
      !resolvedDirectory.startsWith(`${realpathSync(DEV_ROOT)}/`)
    ) {
      throw new Error(`DEV_DIRECTORY_ESCAPE path=${directory}`);
    }
  }
}

/** @param {ServiceId} serviceId @returns {string} */
export function pidRecordPath(serviceId) {
  return join(PID_ROOT, `${serviceId}.json`);
}

const PID_RECORD_KEYS = [
  'artifactDigest',
  'certificateDigest',
  'configDigest',
  'host',
  'ownershipToken',
  'pid',
  'port',
  'processCommand',
  'processStart',
  'readinessSecret',
  'repositoryRoot',
  'runId',
  'schemaVersion',
  'service',
  'startedAt',
].sort();
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_V4_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

/** @param {unknown} value @returns {boolean} */
function isExactIsoTimestamp(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.valueOf()) && timestamp.toISOString() === value;
}

/** @param {ServiceDefinition} definition @param {unknown} candidate @returns {candidate is PidRecord} */
export function isValidPidRecord(definition, candidate) {
  if (typeof candidate !== 'object' || candidate === null) {
    return false;
  }
  const record = /** @type {PidRecord} */ (candidate);
  return (
    JSON.stringify(Object.keys(record).sort()) === JSON.stringify(PID_RECORD_KEYS) &&
    SHA256_PATTERN.test(record.artifactDigest) &&
    SHA256_PATTERN.test(record.certificateDigest) &&
    SHA256_PATTERN.test(record.configDigest) &&
    record.host === '127.0.0.1' &&
    SHA256_PATTERN.test(record.ownershipToken) &&
    Number.isSafeInteger(record.pid) &&
    record.pid > 1 &&
    record.port === definition.port &&
    record.processCommand === expectedProcessCommand(definition) &&
    typeof record.processStart === 'string' &&
    record.processStart.length > 0 &&
    SHA256_PATTERN.test(record.readinessSecret) &&
    record.repositoryRoot === REPOSITORY_ROOT &&
    UUID_V4_PATTERN.test(record.runId) &&
    record.schemaVersion === 2 &&
    record.service === definition.id &&
    isExactIsoTimestamp(record.startedAt)
  );
}

/** @param {ServiceDefinition} definition @returns {PidRecord | null} */
export function readPidRecord(definition) {
  const path = pidRecordPath(definition.id);
  if (!existsSync(path)) {
    return null;
  }

  try {
    assertRegularRepositoryFile(path, 'PID_RECORD_FILE_INVALID');
    const record = JSON.parse(readRepositoryFile(path, 'PID_RECORD_FILE_INVALID').toString());
    return isValidPidRecord(definition, record) ? record : null;
  } catch {
    return null;
  }
}

/** @param {ServiceDefinition} definition @param {PidRecord} record @returns {void} */
export function writePidRecord(definition, record) {
  if (!isValidPidRecord(definition, record)) {
    throw new Error(`PID_RECORD_WRITE_INVALID service=${definition.id}`);
  }
  ensureDevDirectories();
  const finalPath = pidRecordPath(definition.id);
  const temporaryPath = `${finalPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  renameSync(temporaryPath, finalPath);
}

/** @param {ServiceId} serviceId @returns {void} */
export function removePidRecord(serviceId) {
  rmSync(pidRecordPath(serviceId), { force: true });
}

/** @param {number} pid @returns {boolean} */
export function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * True only when the operating system reports that no such process exists.
 *
 * `processExists` treats every `process.kill(pid, 0)` failure as absence, which is the safe
 * direction for "should I signal this?" but the *unsafe* direction for "may I discard this
 * record?": `EPERM` means the PID is live and owned by another user. Releasing a record on that
 * basis would let this repository forget a process it can still see.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function processAbsent(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (
      typeof error === 'object' &&
      error !== null &&
      /** @type {NodeJS.ErrnoException} */ (error).code === 'ESRCH'
    );
  }
}

/**
 * Releases a record whose process no longer exists.
 *
 * Cleanup after a crash has to be idempotent. If the host slept, the terminal was killed, or a
 * service died on its own, the record left behind is stale, and without this path `dev:down`
 * refuses forever with `PID_OWNERSHIP_REFUSED` and needs a human to delete files by hand.
 *
 * **No signal is sent on this path.** The record is removed only after the operating system
 * reports the PID absent and the configured port is confirmed to have no listener under it, so
 * this cannot terminate anything — least of all a sibling repository's process.
 *
 * @param {ServiceDefinition} definition
 * @param {PidRecord} record
 * @returns {boolean} true when a stale record was released
 */
export function releaseStaleRecord(definition, record) {
  if (!processAbsent(record.pid)) {
    return false;
  }
  if (listenerPids(record.port).includes(record.pid)) {
    throw new Error(`PID_STALE_RELEASE_REFUSED service=${definition.id} pid=${record.pid}`);
  }
  removePidRecord(definition.id);
  return true;
}

/** @param {number} pid @returns {string | null} */
export function processStart(pid) {
  if (!processExists(pid)) {
    return null;
  }
  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
    }).trim();
    return output === '' ? null : output;
  } catch {
    return null;
  }
}

/** @param {number} pid @returns {string | null} */
export function processCommand(pid) {
  if (!processExists(pid)) {
    return null;
  }
  try {
    const output = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    }).trim();
    return output === '' ? null : output;
  } catch {
    return null;
  }
}

/** @param {PidRecord} record @returns {boolean} */
function processHasOwnershipEnvironment(record) {
  try {
    const output = execFileSync('ps', ['eww', '-p', String(record.pid), '-o', 'command='], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
    return (
      new RegExp(`(?:^|\\s)DEV_OWNERSHIP_TOKEN=${record.ownershipToken}(?:\\s|$)`, 'u').test(
        output,
      ) && new RegExp(`(?:^|\\s)DEV_RUN_ID=${record.runId}(?:\\s|$)`, 'u').test(output)
    );
  } catch {
    return false;
  }
}

/** @param {number} pid @returns {string | null} */
function processWorkingDirectory(pid) {
  try {
    const output = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
    });
    const pathLine = output.split(/\r?\n/u).find((line) => line.startsWith('n') && line.length > 1);
    return pathLine === undefined ? null : resolve(pathLine.slice(1));
  } catch {
    return null;
  }
}

/** @param {ServiceDefinition} definition @param {PidRecord | null} record @returns {boolean} */
export function isOwnedProcess(definition, record) {
  return (
    record !== null &&
    isValidPidRecord(definition, record) &&
    record.service === definition.id &&
    record.host === '127.0.0.1' &&
    record.port === definition.port &&
    record.repositoryRoot === REPOSITORY_ROOT &&
    record.processCommand === expectedProcessCommand(definition) &&
    processStart(record.pid) === record.processStart &&
    processCommand(record.pid) === record.processCommand &&
    processWorkingDirectory(record.pid) === REPOSITORY_ROOT &&
    processHasOwnershipEnvironment(record)
  );
}

/** @param {string} operation @param {number} [timeoutMs] @returns {() => void} */
export function acquireLifecycleLock(operation, timeoutMs = 10_000) {
  ensureDevDirectories();
  const deadline = Date.now() + timeoutMs;
  const lockToken = randomUUID();
  const ownerStart = processStart(process.pid);
  if (ownerStart === null) {
    throw new Error('LIFECYCLE_LOCK_OWNER_UNINSPECTABLE');
  }

  while (Date.now() < deadline) {
    try {
      const descriptor = openSync(LIFECYCLE_LOCK_PATH, 'wx', 0o600);
      writeFileSync(
        descriptor,
        `${JSON.stringify({
          operation,
          ownerStart,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          token: lockToken,
        })}\n`,
        'utf8',
      );
      closeSync(descriptor);
      return () => {
        let currentLock;
        try {
          currentLock = JSON.parse(
            readRepositoryFile(LIFECYCLE_LOCK_PATH, 'LIFECYCLE_LOCK_INVALID').toString(),
          );
        } catch {
          throw new Error('LIFECYCLE_LOCK_RELEASE_REFUSED reason=missing-or-invalid');
        }
        if (
          typeof currentLock !== 'object' ||
          currentLock === null ||
          currentLock.pid !== process.pid ||
          currentLock.ownerStart !== ownerStart ||
          currentLock.token !== lockToken
        ) {
          throw new Error('LIFECYCLE_LOCK_RELEASE_REFUSED reason=ownership-mismatch');
        }
        rmSync(LIFECYCLE_LOCK_PATH);
      };
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'EEXIST'
      ) {
        throw error;
      }

      try {
        const lock = JSON.parse(
          readRepositoryFile(LIFECYCLE_LOCK_PATH, 'LIFECYCLE_LOCK_INVALID').toString(),
        );
        if (
          typeof lock !== 'object' ||
          lock === null ||
          Object.keys(lock).sort().join(',') !== 'operation,ownerStart,pid,startedAt,token' ||
          typeof lock.operation !== 'string' ||
          lock.operation.length === 0 ||
          typeof lock.ownerStart !== 'string' ||
          !Number.isSafeInteger(lock.pid) ||
          lock.pid <= 0 ||
          typeof lock.startedAt !== 'string' ||
          Number.isNaN(Date.parse(lock.startedAt)) ||
          typeof lock.token !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(lock.token)
        ) {
          throw new Error('LIFECYCLE_LOCK_INVALID', { cause: error });
        }
        if (!processExists(lock.pid) || processStart(lock.pid) !== lock.ownerStart) {
          rmSync(LIFECYCLE_LOCK_PATH, { force: true });
          continue;
        }
      } catch (lockError) {
        if (lockError instanceof Error && lockError.message === 'LIFECYCLE_LOCK_INVALID') {
          throw lockError;
        }
        throw new Error('LIFECYCLE_LOCK_INVALID', { cause: lockError });
      }

      Atomics.wait(LOCK_SLEEP_ARRAY, 0, 0, 100);
    }
  }

  throw new Error(`LIFECYCLE_LOCK_TIMEOUT operation=${operation}`);
}

/** @param {string} output @returns {Array<{name: string, pid: number}>} */
export function parseLsofListenerRecords(output) {
  /** @type {Array<{name: string, pid: number}>} */
  const records = [];
  let currentPid = null;
  for (const line of output.split(/\r?\n/u)) {
    if (line === '') {
      continue;
    }
    if (line.startsWith('p')) {
      const parsedPid = Number.parseInt(line.slice(1), 10);
      if (!Number.isSafeInteger(parsedPid) || parsedPid <= 1) {
        throw new Error('DEV_LISTENER_INSPECTION_PID_INVALID');
      }
      currentPid = parsedPid;
      continue;
    }
    if (line.startsWith('n')) {
      if (currentPid === null || line.length === 1) {
        throw new Error('DEV_LISTENER_INSPECTION_NAME_INVALID');
      }
      records.push({ name: line.slice(1), pid: currentPid });
    }
  }
  return records;
}

/** @param {number} port @returns {Array<{name: string, pid: number}>} */
export function listenerRecords(port) {
  try {
    const output = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'], {
      encoding: 'utf8',
    }).trim();
    if (output === '') {
      return [];
    }
    return parseLsofListenerRecords(output);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 1) {
      return [];
    }
    throw error;
  }
}

/** @param {number} port @returns {number[]} */
export function listenerPids(port) {
  return [...new Set(listenerRecords(port).map((record) => record.pid))];
}

/**
 * @param {Array<{name: string, pid: number}>} records
 * @param {number} pid
 * @param {number} port
 * @returns {boolean}
 */
export function isExclusiveLoopbackListener(records, pid, port) {
  return (
    records.length > 0 &&
    records.every((record) => record.pid === pid && record.name === `127.0.0.1:${port}`)
  );
}

/** @param {number} port @returns {string} */
export function listenerDescription(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return `listener on port ${port}`;
  }
}

/** @param {ServiceDefinition} definition @param {PidRecord} record @returns {void} */
export function assertOwnedLoopbackListener(definition, record) {
  if (!isOwnedProcess(definition, record)) {
    throw new Error(`DEV_LISTENER_OWNERSHIP service=${definition.id}`);
  }
  const records = listenerRecords(definition.port);
  const pids = [...new Set(records.map((listener) => listener.pid))];
  if (pids.length !== 1 || pids[0] !== record.pid) {
    throw new Error(`DEV_LISTENER_PID service=${definition.id}`);
  }
  if (!isExclusiveLoopbackListener(records, record.pid, definition.port)) {
    throw new Error(`DEV_LISTENER_HOST service=${definition.id} expected=127.0.0.1`);
  }
}

/** @param {string} command @param {string[]} args @returns {void} */
function assertRequiredExecutable(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`DEV_TOOL_MISSING command=${command}`);
  }
}

function assertRuntimeVersion() {
  const [major, minor] = process.versions.node
    .split('.')
    .slice(0, 2)
    .map((value) => Number.parseInt(value, 10));
  if (
    major === undefined ||
    minor === undefined ||
    major < REQUIRED_NODE_MAJOR_MIN ||
    major > REQUIRED_NODE_MAJOR_MAX ||
    (major === REQUIRED_NODE_MAJOR_MIN && minor < REQUIRED_NODE_24_MINOR_MIN)
  ) {
    throw new Error(`NODE_VERSION_UNSUPPORTED actual=${process.version} expected=>=24.19.0 <27`);
  }
}

function assertRepositoryToolConfiguration() {
  if (resolve(process.cwd()) !== REPOSITORY_ROOT) {
    throw new Error(
      `REPOSITORY_CWD_REQUIRED actual=${resolve(process.cwd())} expected=${REPOSITORY_ROOT}`,
    );
  }
  const npmVersion = spawnSync('npm', ['--version'], {
    encoding: 'utf8',
    env: withRepositoryNpmCache(process.env),
  });
  if (npmVersion.status !== 0 || npmVersion.stdout.trim() !== '11.17.0') {
    throw new Error(
      `NPM_VERSION_UNSUPPORTED actual=${npmVersion.stdout.trim() || 'missing'} expected=11.17.0`,
    );
  }
  const npmCache = spawnSync('npm', ['config', 'get', 'cache'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    env: withRepositoryNpmCache(process.env),
  });
  const expectedNpmCache = REPOSITORY_NPM_CACHE;
  if (npmCache.status !== 0 || resolve(npmCache.stdout.trim()) !== expectedNpmCache) {
    throw new Error(
      `NPM_CACHE_OUTSIDE_REPOSITORY actual=${npmCache.stdout.trim() || 'missing'} expected=${expectedNpmCache}`,
    );
  }
  const strictScripts = spawnSync('npm', ['config', 'get', 'strict-allow-scripts'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    env: withRepositoryNpmCache(process.env),
  });
  if (strictScripts.status !== 0 || strictScripts.stdout.trim() !== 'true') {
    throw new Error('NPM_LIFECYCLE_ALLOWLIST_NOT_STRICT');
  }
  const configuredPlaywrightCache = process.env['PLAYWRIGHT_BROWSERS_PATH'];
  if (
    configuredPlaywrightCache !== undefined &&
    resolve(configuredPlaywrightCache) !== PLAYWRIGHT_BROWSER_CACHE_PATH
  ) {
    throw new Error(
      `PLAYWRIGHT_CACHE_OUTSIDE_REPOSITORY actual=${configuredPlaywrightCache} expected=${PLAYWRIGHT_BROWSER_CACHE_PATH}`,
    );
  }
  if (existsSync(join(REPOSITORY_ROOT, 'tsconfig.tsbuildinfo'))) {
    throw new Error('TOOL_CACHE_AT_REPOSITORY_ROOT path=tsconfig.tsbuildinfo');
  }

  /** @param {string} directory @returns {void} */
  function inspectForNestedDev(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.name === '.dev') {
        if (resolve(path) !== DEV_ROOT) {
          throw new Error(`NESTED_DEV_DIRECTORY_REFUSED path=${path}`);
        }
        continue;
      }
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        ['.git', 'coverage', 'dist', 'node_modules'].includes(entry.name)
      ) {
        continue;
      }
      inspectForNestedDev(path);
    }
  }
  inspectForNestedDev(REPOSITORY_ROOT);
}

function assertDevDirectoryIgnored() {
  const result = spawnSync('git', ['check-ignore', '--quiet', '.dev/probe'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error('DEV_DIRECTORY_NOT_GIT_IGNORED path=.dev/');
  }
}

/** @param {ServiceDefinition[]} definitions @returns {Map<number, number>} */
function inspectPidRecords(definitions) {
  const ownedByPort = new Map();
  for (const definition of definitions) {
    const recordPath = pidRecordPath(definition.id);
    const record = readPidRecord(definition);
    if (record === null && existsSync(recordPath)) {
      throw new Error(`PID_RECORD_INVALID service=${definition.id}`);
    }
    if (record !== null && !isOwnedProcess(definition, record) && processExists(record.pid)) {
      throw new Error(`PID_RECORD_OWNERSHIP_UNCERTAIN service=${definition.id} pid=${record.pid}`);
    }
    if (record !== null && !processExists(record.pid)) {
      removePidRecord(definition.id);
      continue;
    }
    if (record !== null) {
      ownedByPort.set(definition.port, record.pid);
    }
  }
  return ownedByPort;
}

export function runPreflight() {
  assertRuntimeVersion();
  assertRepositoryToolConfiguration();
  assertBuildPathsSafe();
  assertRequiredExecutable('git', ['--version']);
  assertRequiredExecutable('lsof', ['-v']);
  assertRequiredExecutable('openssl', ['version']);
  ensureDevDirectories();
  assertDevDirectoryIgnored();

  const ports = readPorts();
  const definitions = serviceDefinitions(ports);
  const ownedByPort = inspectPidRecords(definitions);

  for (let port = ALLOWED_PORT_MIN; port <= ALLOWED_PORT_MAX; port += 1) {
    for (const pid of listenerPids(port)) {
      if (ownedByPort.get(port) !== pid) {
        throw new Error(`FOREIGN_PORT_LISTENER port=${port}\n${listenerDescription(port)}`);
      }
    }
  }

  return { definitions, ports };
}

export function ensureCertificate() {
  ensureDevDirectories();
  if (existsSync(CERTIFICATE_PATH)) {
    assertRegularRepositoryFile(CERTIFICATE_PATH, 'TLS_CERTIFICATE_FILE_INVALID');
  }
  if (existsSync(CERTIFICATE_KEY_PATH)) {
    assertRegularRepositoryFile(CERTIFICATE_KEY_PATH, 'TLS_KEY_FILE_INVALID');
  }
  const certificateInspection = existsSync(CERTIFICATE_PATH)
    ? spawnSync('openssl', ['x509', '-noout', '-text', '-in', CERTIFICATE_PATH], {
        encoding: 'utf8',
      })
    : null;
  const certificateIsFresh =
    existsSync(CERTIFICATE_PATH) &&
    existsSync(CERTIFICATE_KEY_PATH) &&
    spawnSync('openssl', ['x509', '-checkend', '86400', '-noout', '-in', CERTIFICATE_PATH])
      .status === 0;
  const certificateHasRequiredConstraints =
    certificateInspection !== null &&
    certificateInspection.status === 0 &&
    certificateInspection.stdout.includes('CA:TRUE') &&
    certificateInspection.stdout.includes('IP Address:127.0.0.1');
  const certificateMatchesKey =
    existsSync(CERTIFICATE_PATH) &&
    existsSync(CERTIFICATE_KEY_PATH) &&
    certificateKeyPairMatches(CERTIFICATE_PATH, CERTIFICATE_KEY_PATH);

  if (certificateIsFresh && certificateHasRequiredConstraints && certificateMatchesKey) {
    return;
  }

  const generationDirectory = mkdtempSync(join(DEV_ROOT, 'tmp', 'tls-'));
  const configPath = join(generationDirectory, 'openssl.cnf');
  const generatedCertificatePath = join(generationDirectory, 'localhost.pem');
  const generatedKeyPath = join(generationDirectory, 'localhost-key.pem');
  writeFileSync(
    configPath,
    `[req]\n` +
      `distinguished_name=req_distinguished_name\n` +
      `x509_extensions=v3_req\n` +
      `prompt=no\n` +
      `[req_distinguished_name]\n` +
      `CN=127.0.0.1\n` +
      `[v3_req]\n` +
      `basicConstraints=critical,CA:TRUE\n` +
      `subjectAltName=@alt_names\n` +
      `keyUsage=critical,digitalSignature,keyEncipherment\n` +
      `extendedKeyUsage=serverAuth\n` +
      `[alt_names]\n` +
      `IP.1=127.0.0.1\n` +
      `DNS.1=localhost\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );

  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '30',
      '-keyout',
      generatedKeyPath,
      '-out',
      generatedCertificatePath,
      '-config',
      configPath,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    rmSync(generationDirectory, { force: true, recursive: true });
    throw new Error(`TLS_CERTIFICATE_GENERATION_FAILED ${result.stderr.trim()}`);
  }
  try {
    assertRegularRepositoryFile(generatedCertificatePath, 'TLS_CERTIFICATE_GENERATED_INVALID');
    assertRegularRepositoryFile(generatedKeyPath, 'TLS_KEY_GENERATED_INVALID');
    chmodSync(generatedCertificatePath, 0o600);
    chmodSync(generatedKeyPath, 0o600);
    renameSync(generatedKeyPath, CERTIFICATE_KEY_PATH);
    renameSync(generatedCertificatePath, CERTIFICATE_PATH);
  } finally {
    rmSync(generationDirectory, { force: true, recursive: true });
  }
}

/** @param {string} certificatePath @param {string} keyPath @returns {boolean} */
export function certificateKeyPairMatches(certificatePath, keyPath) {
  try {
    assertRegularRepositoryFile(certificatePath, 'TLS_CERTIFICATE_FILE_INVALID');
    assertRegularRepositoryFile(keyPath, 'TLS_KEY_FILE_INVALID');
    const certificatePublicKey = spawnSync(
      'openssl',
      ['x509', '-pubkey', '-noout', '-in', certificatePath],
      { encoding: 'utf8' },
    );
    const keyPublicKey = spawnSync('openssl', ['pkey', '-pubout', '-in', keyPath], {
      encoding: 'utf8',
    });
    return (
      certificatePublicKey.status === 0 &&
      keyPublicKey.status === 0 &&
      certificatePublicKey.stdout.length > 0 &&
      certificatePublicKey.stdout === keyPublicKey.stdout
    );
  } catch {
    return false;
  }
}

/** @param {ServiceId} serviceId @returns {{close: () => void, descriptor: number}} */
export function serviceLogDescriptor(serviceId) {
  ensureDevDirectories();
  const path = join(LOG_ROOT, `${serviceId}.log`);
  let descriptor;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    throw new Error(`DEV_LOG_FILE_REFUSED service=${serviceId}`, { cause: error });
  }
  fchmodSync(descriptor, 0o600);
  return {
    close: () => closeSync(descriptor),
    descriptor,
  };
}

/** @param {ServiceDefinition} definition @param {number} timeoutMs @returns {Promise<void>} */
function applicationRequest(definition, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const applicationRequestHandle = request(
      new URL(`https://127.0.0.1:${definition.port}/`),
      {
        ca: readRepositoryFile(CERTIFICATE_PATH, 'TLS_CERTIFICATE_FILE_INVALID'),
        headers: { accept: 'text/html' },
        method: 'GET',
        rejectUnauthorized: true,
        timeout: timeoutMs,
      },
      (response) => {
        /** @type {Buffer[]} */
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const contentType = response.headers['content-type'] ?? '';
          if (
            response.statusCode !== 200 ||
            !contentType.startsWith('text/html') ||
            !body.includes('<div id="app"></div>') ||
            !body.includes('Not yet in production')
          ) {
            rejectPromise(new Error(`DEV_APPLICATION_NOT_READY service=${definition.id}`));
            return;
          }
          resolvePromise(undefined);
        });
      },
    );
    applicationRequestHandle.on('timeout', () => {
      applicationRequestHandle.destroy(
        new Error(`DEV_APPLICATION_TIMEOUT service=${definition.id}`),
      );
    });
    applicationRequestHandle.on('error', rejectPromise);
    applicationRequestHandle.end();
  });
}

/** @param {ServiceDefinition} definition @param {number} [timeoutMs] @returns {Promise<ReadinessPayload>} */
export function healthRequest(definition, timeoutMs = 5_000) {
  const record = readPidRecord(definition);
  if (record === null) {
    return Promise.reject(new Error(`DEV_HEALTH_PID_MISSING service=${definition.id}`));
  }
  try {
    assertOwnedLoopbackListener(definition, record);
  } catch (error) {
    return Promise.reject(error);
  }
  if (!existsSync(CERTIFICATE_PATH) || fileDigest(CERTIFICATE_PATH) !== record.certificateDigest) {
    return Promise.reject(new Error(`DEV_HEALTH_CERTIFICATE_MISMATCH service=${definition.id}`));
  }

  const readinessRequest = new Promise((resolvePromise, rejectPromise) => {
    const challenge = randomBytes(32).toString('hex');
    const healthUrl = new URL(`https://127.0.0.1:${definition.port}/readyz`);
    healthUrl.searchParams.set('challenge', challenge);
    const healthRequestHandle = request(
      healthUrl,
      {
        ca: readRepositoryFile(CERTIFICATE_PATH, 'TLS_CERTIFICATE_FILE_INVALID'),
        headers: { accept: 'application/json' },
        method: 'GET',
        rejectUnauthorized: true,
        timeout: timeoutMs,
      },
      (response) => {
        /** @type {Buffer[]} */
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (response.statusCode !== 200) {
            rejectPromise(
              new Error(
                `DEV_HEALTH_HTTP service=${definition.id} status=${String(response.statusCode)}`,
              ),
            );
            return;
          }

          try {
            const payload = JSON.parse(body);
            if (
              typeof payload !== 'object' ||
              payload === null ||
              payload.status !== 'ready' ||
              payload.service !== definition.id ||
              payload.repository !== REPOSITORY_NAME ||
              payload.host !== '127.0.0.1' ||
              payload.port !== definition.port ||
              payload.pid !== record.pid ||
              payload.runId !== record.runId ||
              payload.configDigest !== record.configDigest ||
              payload.artifactDigest !== record.artifactDigest ||
              payload.certificateDigest !== record.certificateDigest ||
              typeof payload.signature !== 'string'
            ) {
              rejectPromise(new Error(`DEV_HEALTH_SCHEMA service=${definition.id}`));
              return;
            }

            const expectedSignature = readinessSignature(record.readinessSecret, {
              artifactDigest: record.artifactDigest,
              certificateDigest: record.certificateDigest,
              challenge,
              configDigest: record.configDigest,
              pid: record.pid,
              port: definition.port,
              runId: record.runId,
              service: definition.id,
            });
            const receivedSignature = Buffer.from(payload.signature, 'hex');
            const expectedSignatureBuffer = Buffer.from(expectedSignature, 'hex');
            if (
              receivedSignature.length !== expectedSignatureBuffer.length ||
              !timingSafeEqual(receivedSignature, expectedSignatureBuffer)
            ) {
              rejectPromise(new Error(`DEV_HEALTH_PROOF service=${definition.id}`));
              return;
            }
            resolvePromise(payload);
          } catch (error) {
            rejectPromise(
              new Error(`DEV_HEALTH_INVALID_JSON service=${definition.id}`, { cause: error }),
            );
          }
        });
      },
    );

    healthRequestHandle.on('timeout', () => {
      healthRequestHandle.destroy(new Error(`DEV_HEALTH_TIMEOUT service=${definition.id}`));
    });
    healthRequestHandle.on('error', rejectPromise);
    healthRequestHandle.end();
  });
  return readinessRequest.then(async (payload) => {
    if (definition.id !== 'fixtures') {
      await applicationRequest(definition, timeoutMs);
    }
    return /** @type {ReadinessPayload} */ (payload);
  });
}

/**
 * Flattens an error and its `cause` chain into one line.
 *
 * A readiness failure that reports only its outermost code is undiagnosable after the fact, which
 * is how a real hang and a transient slow start become indistinguishable. Every lifecycle entry
 * point prints this instead of `error.message`.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function formatErrorChain(error) {
  /** @type {string[]} */
  const parts = [];
  let current = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(' <- ');
}

/**
 * Records one failed readiness attempt so a transient failure remains diagnosable after the run
 * that observed it has exited. Never throws: losing a diagnostic line must not fail a gate.
 *
 * @param {ServiceId} serviceId
 * @param {string} line
 * @returns {void}
 */
function appendHealthDiagnostic(serviceId, line) {
  try {
    mkdirSync(LOG_ROOT, { recursive: true, mode: 0o700 });
    const descriptor = openSync(
      join(LOG_ROOT, 'health.log'),
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(descriptor, `${new Date().toISOString()} service=${serviceId} ${line}\n`);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    // Diagnostics are best-effort; the readiness verdict itself is authoritative.
  }
}

/** @param {ServiceDefinition} definition @param {number} [timeoutMs] @returns {Promise<ReadinessPayload>} */
export async function waitForHealth(definition, timeoutMs = 60_000) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastError = null;
  let attempts = 0;
  /** @type {string[]} */
  const distinctReasons = [];
  let expectedArtifactDigest;
  try {
    expectedArtifactDigest = desiredArtifactDigest(definition);
  } catch (error) {
    throw new Error(`DEV_HEALTH_ARTIFACT_UNAVAILABLE service=${definition.id}`, { cause: error });
  }

  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const record = readPidRecord(definition);
      if (record !== null && record.artifactDigest !== expectedArtifactDigest) {
        throw new Error(`DEV_HEALTH_ARTIFACT_STALE service=${definition.id}`);
      }
      const payload = await healthRequest(definition);
      if (attempts > 1) {
        appendHealthDiagnostic(
          definition.id,
          `recovered attempts=${String(attempts)} elapsedMs=${String(Date.now() - startedAt)} reasons=${distinctReasons.join('|')}`,
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('DEV_HEALTH_ARTIFACT_STALE')) {
        throw error;
      }
      lastError = error;
      const reason = formatErrorChain(error);
      if (!distinctReasons.includes(reason)) {
        distinctReasons.push(reason);
      }
      appendHealthDiagnostic(
        definition.id,
        `attempt=${String(attempts)} elapsedMs=${String(Date.now() - startedAt)} reason=${reason}`,
      );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    }
  }

  throw new Error(
    `DEV_HEALTH_DEADLINE service=${definition.id} attempts=${String(attempts)} timeoutMs=${String(timeoutMs)} reasons=${distinctReasons.join('|')}`,
    { cause: lastError },
  );
}

/** @param {ServiceDefinition} definition @param {PidRecord} record @param {number} [timeoutMs] @returns {Promise<void>} */
export async function stopOwnedRecord(definition, record, timeoutMs = 5_000) {
  try {
    assertOwnedLoopbackListener(definition, record);
  } catch {
    throw new Error(`PID_OWNERSHIP_REFUSED service=${definition.id} pid=${record.pid}`);
  }

  // Re-evaluate every independently observable ownership signal immediately
  // before signaling. A PID record alone is never authority to terminate.
  assertOwnedLoopbackListener(definition, record);
  process.kill(record.pid, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (processExists(record.pid) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }

  if (processExists(record.pid)) {
    try {
      assertOwnedLoopbackListener(definition, record);
    } catch {
      throw new Error(`PID_REUSED_DURING_SHUTDOWN service=${definition.id} pid=${record.pid}`);
    }
    process.kill(record.pid, 'SIGKILL');
    const killDeadline = Date.now() + 2_000;
    while (processExists(record.pid) && Date.now() < killDeadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }

  if (processExists(record.pid)) {
    throw new Error(`PID_STOP_UNCONFIRMED service=${definition.id} pid=${record.pid}`);
  }
  if (listenerPids(record.port).includes(record.pid)) {
    throw new Error(`PORT_RELEASE_UNCONFIRMED service=${definition.id} port=${record.port}`);
  }

  removePidRecord(definition.id);
}
