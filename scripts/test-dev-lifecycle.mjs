import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { withRepositoryNpmCache } from './npm-environment.mjs';

import {
  CERTIFICATE_KEY_PATH,
  CERTIFICATE_PATH,
  REPOSITORY_ROOT,
  acquireLifecycleLock,
  certificateKeyPairMatches,
  desiredArtifactDigest,
  ensureCertificate,
  expectedProcessCommand,
  isOwnedProcess,
  isValidPidRecord,
  pidRecordPath,
  processCommand,
  processExists,
  processStart,
  readPidRecord,
  runPreflight,
  serviceLogDescriptor,
  serviceDefinitions,
  stopOwnedRecord,
  waitForHealth,
  writePidRecord,
} from './dev/lib.mjs';

/**
 * @param {string} script
 * @param {{expectSuccess?: boolean, expectedText?: string}} [options]
 * @returns {ReturnType<typeof spawnSync>}
 */
function runScript(script, options = {}) {
  const result = spawnSync('npm', ['run', script], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    env: withRepositoryNpmCache(process.env),
  });
  const combinedOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const expectSuccess = options.expectSuccess ?? true;
  if (expectSuccess && result.status !== 0) {
    throw new Error(`INTEGRATION_COMMAND_FAILED script=${script}\n${combinedOutput}`);
  }
  if (!expectSuccess && result.status === 0) {
    throw new Error(`INTEGRATION_COMMAND_UNEXPECTED_SUCCESS script=${script}`);
  }
  if (options.expectedText !== undefined && !combinedOutput.includes(options.expectedText)) {
    throw new Error(
      `INTEGRATION_OUTPUT_MISSING script=${script} expected=${options.expectedText}\n${combinedOutput}`,
    );
  }
  return result;
}

/** @param {() => void} action @param {string} expectedText @returns {void} */
function expectSynchronousFailure(action, expectedText) {
  try {
    action();
    throw new Error(`INTEGRATION_OPERATION_UNEXPECTED_SUCCESS expected=${expectedText}`);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(expectedText)) {
      throw error;
    }
  }
}

/** @param {number} pid @param {number} [timeoutMs] @returns {Promise<void>} */
async function waitForExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  if (processExists(pid)) {
    throw new Error(`INTEGRATION_PROCESS_STILL_ALIVE pid=${pid}`);
  }
}

/** @param {import('node:child_process').ChildProcess} child @returns {Promise<void>} */
async function waitForReady(child) {
  await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(
      () => rejectPromise(new Error('INTEGRATION_FOREIGN_LISTENER_TIMEOUT')),
      5_000,
    );
    child.once('error', rejectPromise);
    child.stdout?.once('data', (chunk) => {
      clearTimeout(timeout);
      if (!String(chunk).includes('ready 4189')) {
        rejectPromise(new Error('INTEGRATION_FOREIGN_LISTENER_BAD_READY'));
        return;
      }
      resolvePromise(undefined);
    });
  });
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {string} expectedText
 * @returns {Promise<void>}
 */
async function waitForChildOutput(child, expectedText) {
  await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(
      () => rejectPromise(new Error(`INTEGRATION_CHILD_OUTPUT_TIMEOUT expected=${expectedText}`)),
      5_000,
    );
    /** @param {Buffer | string} chunk */
    const onData = (chunk) => {
      if (!String(chunk).includes(expectedText)) {
        return;
      }
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      resolvePromise(undefined);
    };
    child.once('error', rejectPromise);
    child.stdout?.on('data', onData);
  });
}

/** @type {import('node:child_process').ChildProcess | null} */
let foreignListener = null;
/** @type {import('node:child_process').ChildProcess | null} */
let lockHolder = null;
let testPidRecordInstalled = false;
/** @type {ReturnType<typeof readPidRecord>} */
let artifactDriftOriginalRecord = null;

try {
  runScript('dev:down');

  ensureCertificate();
  const certificateBackupPath = join(
    REPOSITORY_ROOT,
    '.dev',
    'tmp',
    'localhost.pem.integration-backup',
  );
  const keyBackupPath = join(
    REPOSITORY_ROOT,
    '.dev',
    'tmp',
    'localhost-key.pem.integration-backup',
  );
  copyFileSync(CERTIFICATE_PATH, certificateBackupPath);
  copyFileSync(CERTIFICATE_KEY_PATH, keyBackupPath);
  let certificateRecoverySucceeded = false;
  try {
    execFileSync(
      'openssl',
      [
        'genpkey',
        '-algorithm',
        'RSA',
        '-pkeyopt',
        'rsa_keygen_bits:2048',
        '-out',
        CERTIFICATE_KEY_PATH,
      ],
      { stdio: 'ignore' },
    );
    if (certificateKeyPairMatches(CERTIFICATE_PATH, CERTIFICATE_KEY_PATH)) {
      throw new Error('INTEGRATION_TLS_MISMATCH_SETUP_FAILED');
    }
    ensureCertificate();
    if (!certificateKeyPairMatches(CERTIFICATE_PATH, CERTIFICATE_KEY_PATH)) {
      throw new Error('INTEGRATION_TLS_MISMATCH_NOT_RECOVERED');
    }
    certificateRecoverySucceeded = true;
  } finally {
    if (!certificateRecoverySucceeded) {
      copyFileSync(certificateBackupPath, CERTIFICATE_PATH);
      copyFileSync(keyBackupPath, CERTIFICATE_KEY_PATH);
    }
    rmSync(certificateBackupPath, { force: true });
    rmSync(keyBackupPath, { force: true });
  }

  const pwaLogPath = join(REPOSITORY_ROOT, '.dev', 'logs', 'pwa.log');
  const pwaLogBackupPath = join(REPOSITORY_ROOT, '.dev', 'tmp', 'pwa.log.integration-backup');
  const logSentinelPath = join(REPOSITORY_ROOT, '.dev', 'tmp', 'log-symlink-sentinel');
  const originalLogExisted = existsSync(pwaLogPath);
  if (originalLogExisted) {
    renameSync(pwaLogPath, pwaLogBackupPath);
  }
  writeFileSync(logSentinelPath, 'must remain unchanged\n', 'utf8');
  symlinkSync(logSentinelPath, pwaLogPath);
  try {
    expectSynchronousFailure(() => serviceLogDescriptor('pwa'), 'DEV_LOG_FILE_REFUSED');
    if (readFileSync(logSentinelPath, 'utf8') !== 'must remain unchanged\n') {
      throw new Error('INTEGRATION_LOG_SYMLINK_SENTINEL_CHANGED');
    }
  } finally {
    rmSync(pwaLogPath, { force: true });
    rmSync(logSentinelPath, { force: true });
    if (originalLogExisted) {
      renameSync(pwaLogBackupPath, pwaLogPath);
    }
  }

  lockHolder = spawn(process.execPath, ['tests/helpers/lifecycle-lock-holder.mjs', '750'], {
    cwd: REPOSITORY_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (lockHolder.pid === undefined) {
    throw new Error('INTEGRATION_LOCK_HOLDER_PID_MISSING');
  }
  await waitForChildOutput(lockHolder, 'lock-ready');
  const lockWaitStartedAt = Date.now();
  runScript('dev:preflight');
  const lockWaitDurationMs = Date.now() - lockWaitStartedAt;
  if (lockWaitDurationMs < 500) {
    throw new Error(`INTEGRATION_LOCK_NOT_SERIALIZED durationMs=${lockWaitDurationMs}`);
  }
  await waitForExit(lockHolder.pid);
  lockHolder = null;

  const pwaDefinition = serviceDefinitions()[0];
  if (pwaDefinition === undefined) {
    throw new Error('INTEGRATION_SERVICE_DEFINITION_MISSING');
  }
  const staleRecordPath = pidRecordPath(pwaDefinition.id);
  let releaseRecordTestLock = acquireLifecycleLock('integration-stale-record', 120_000);
  try {
    writeFileSync(
      staleRecordPath,
      `${JSON.stringify({
        artifactDigest: 'a'.repeat(64),
        certificateDigest: 'b'.repeat(64),
        configDigest: 'c'.repeat(64),
        host: '127.0.0.1',
        ownershipToken: 'e'.repeat(64),
        pid: 999_999_999,
        port: pwaDefinition.port,
        processCommand: expectedProcessCommand(pwaDefinition),
        processStart: 'nonexistent',
        readinessSecret: 'd'.repeat(64),
        repositoryRoot: REPOSITORY_ROOT,
        runId: '00000000-0000-4000-8000-000000000000',
        schemaVersion: 2,
        service: 'pwa',
        startedAt: '2026-08-09T00:00:00.000Z',
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    testPidRecordInstalled = true;
    runPreflight();
    if (existsSync(staleRecordPath)) {
      throw new Error('INTEGRATION_STALE_PID_NOT_REMOVED');
    }
    testPidRecordInstalled = false;
  } finally {
    releaseRecordTestLock();
  }

  const currentCommand = processCommand(process.pid);
  const currentStart = processStart(process.pid);
  if (currentCommand === null || currentStart === null) {
    throw new Error('INTEGRATION_CURRENT_PROCESS_UNINSPECTABLE');
  }
  releaseRecordTestLock = acquireLifecycleLock('integration-forged-record', 120_000);
  try {
    writeFileSync(
      staleRecordPath,
      `${JSON.stringify({
        artifactDigest: 'a'.repeat(64),
        certificateDigest: 'b'.repeat(64),
        configDigest: 'c'.repeat(64),
        host: '127.0.0.1',
        ownershipToken: 'e'.repeat(64),
        pid: process.pid,
        port: pwaDefinition.port,
        processCommand: currentCommand,
        processStart: currentStart,
        readinessSecret: 'd'.repeat(64),
        repositoryRoot: REPOSITORY_ROOT,
        runId: '00000000-0000-4000-8000-000000000000',
        schemaVersion: 2,
        service: 'pwa',
        startedAt: '2026-08-09T00:00:00.000Z',
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    testPidRecordInstalled = true;
    expectSynchronousFailure(runPreflight, 'PID_RECORD_INVALID');
    if (!processExists(process.pid)) {
      throw new Error('INTEGRATION_PREFLIGHT_SIGNALED_CALLER');
    }
    rmSync(staleRecordPath, { force: true });
    testPidRecordInstalled = false;
  } finally {
    releaseRecordTestLock();
  }

  foreignListener = spawn(process.execPath, ['tests/helpers/foreign-listener.mjs', '4189'], {
    cwd: REPOSITORY_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (foreignListener.pid === undefined) {
    throw new Error('INTEGRATION_FOREIGN_LISTENER_PID_MISSING');
  }
  await waitForReady(foreignListener);
  runScript('dev:preflight', {
    expectSuccess: false,
    expectedText: 'FOREIGN_PORT_LISTENER port=4189',
  });
  if (!processExists(foreignListener.pid)) {
    throw new Error('INTEGRATION_PREFLIGHT_KILLED_FOREIGN_LISTENER');
  }
  foreignListener.kill('SIGTERM');
  await waitForExit(foreignListener.pid);
  foreignListener = null;

  try {
    await waitForHealth(pwaDefinition, 300);
    throw new Error('INTEGRATION_HEALTH_UNEXPECTED_SUCCESS');
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('DEV_HEALTH_DEADLINE')) {
      throw error;
    }
  }

  runScript('dev:up');
  const livePwaRecord = readPidRecord(pwaDefinition);
  if (livePwaRecord === null) {
    throw new Error('INTEGRATION_LIVE_PID_RECORD_MISSING');
  }
  const wrongEnvironmentRecord = {
    ...livePwaRecord,
    ownershipToken: 'f'.repeat(64),
  };
  if (!isValidPidRecord(pwaDefinition, wrongEnvironmentRecord)) {
    throw new Error('INTEGRATION_FORGED_RECORD_NOT_SCHEMA_VALID');
  }
  try {
    await stopOwnedRecord(pwaDefinition, wrongEnvironmentRecord);
    throw new Error('INTEGRATION_FORGED_ENV_UNEXPECTED_STOP');
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('PID_OWNERSHIP_REFUSED')) {
      throw error;
    }
  }
  if (!processExists(livePwaRecord.pid)) {
    throw new Error('INTEGRATION_FORGED_ENV_SIGNALED_OWNED_SERVICE');
  }
  runScript('dev:health');

  const recordsBeforeRetention = new Map(
    serviceDefinitions().map((definition) => {
      const record = readPidRecord(definition);
      if (record === null) {
        throw new Error(`INTEGRATION_RETENTION_RECORD_MISSING service=${definition.id}`);
      }
      return [definition.id, record];
    }),
  );
  runScript('dev:up');
  for (const definition of serviceDefinitions()) {
    const before = recordsBeforeRetention.get(definition.id);
    const after = readPidRecord(definition);
    if (before === undefined || after === null || before.pid !== after.pid) {
      throw new Error(`INTEGRATION_HEALTHY_SERVICE_NOT_RETAINED service=${definition.id}`);
    }
  }

  const recordToRestart = readPidRecord(pwaDefinition);
  if (recordToRestart === null) {
    throw new Error('INTEGRATION_RESTART_RECORD_MISSING');
  }
  artifactDriftOriginalRecord = recordToRestart;
  releaseRecordTestLock = acquireLifecycleLock('integration-artifact-drift', 120_000);
  try {
    writePidRecord(pwaDefinition, {
      ...recordToRestart,
      artifactDigest: '0'.repeat(64),
    });
  } finally {
    releaseRecordTestLock();
  }
  try {
    await waitForHealth(pwaDefinition, 300);
    throw new Error('INTEGRATION_STALE_ARTIFACT_HEALTH_UNEXPECTED_SUCCESS');
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('DEV_HEALTH_ARTIFACT_STALE')) {
      throw error;
    }
  }
  if (!processExists(recordToRestart.pid)) {
    throw new Error('INTEGRATION_STALE_ARTIFACT_HEALTH_SIGNALED_PROCESS');
  }
  runScript('dev:up');
  artifactDriftOriginalRecord = null;
  for (const definition of serviceDefinitions()) {
    const before = recordsBeforeRetention.get(definition.id);
    const after = readPidRecord(definition);
    if (before === undefined || after === null) {
      throw new Error(`INTEGRATION_RESTART_RECORD_MISSING service=${definition.id}`);
    }
    if (definition.id === pwaDefinition.id && before.pid === after.pid) {
      throw new Error('INTEGRATION_ARTIFACT_DRIFT_DID_NOT_RESTART service=pwa');
    }
    if (definition.id !== pwaDefinition.id && before.pid !== after.pid) {
      throw new Error(`INTEGRATION_ARTIFACT_DRIFT_RESTARTED_UNCHANGED service=${definition.id}`);
    }
  }

  const ownedPids = serviceDefinitions().map((definition) => {
    const record = readPidRecord(definition);
    if (record === null) {
      throw new Error(`INTEGRATION_PID_RECORD_MISSING service=${definition.id}`);
    }
    return record.pid;
  });

  runScript('dev:down');
  for (const pid of ownedPids) {
    if (processExists(pid)) {
      throw new Error(`INTEGRATION_DOWN_LEFT_PROCESS pid=${pid}`);
    }
  }
  runScript('dev:health', { expectSuccess: false, expectedText: 'DEV_HEALTH_DEADLINE' });

  runScript('dev:up');
  runScript('dev:health');
  console.log(
    'test-integration passed cases=tls-mismatch-recovery,log-symlink-refusal,serialized-lock,stale-pid,forged-same-cwd-pid,wrong-ownership-environment,foreign-listener,health-timeout,retention,stale-artifact-health,artifact-drift-restart,owned-down,restore',
  );
} finally {
  if (lockHolder?.pid !== undefined && processExists(lockHolder.pid)) {
    lockHolder.kill('SIGTERM');
    await waitForExit(lockHolder.pid).catch(() => undefined);
  }
  if (foreignListener?.pid !== undefined && processExists(foreignListener.pid)) {
    foreignListener.kill('SIGTERM');
    await waitForExit(foreignListener.pid).catch(() => undefined);
  }
  if (testPidRecordInstalled) {
    const releaseCleanupLock = acquireLifecycleLock('integration-record-cleanup', 120_000);
    try {
      rmSync(pidRecordPath('pwa'), { force: true });
    } finally {
      releaseCleanupLock();
    }
  }
  if (artifactDriftOriginalRecord !== null) {
    const cleanupDefinition = serviceDefinitions().find(
      (definition) => definition.id === artifactDriftOriginalRecord?.service,
    );
    if (cleanupDefinition !== undefined) {
      const releaseDriftCleanupLock = acquireLifecycleLock('integration-artifact-cleanup', 120_000);
      try {
        const currentRecord = readPidRecord(cleanupDefinition);
        if (
          currentRecord !== null &&
          currentRecord.pid === artifactDriftOriginalRecord.pid &&
          isOwnedProcess(cleanupDefinition, currentRecord)
        ) {
          writePidRecord(cleanupDefinition, artifactDriftOriginalRecord);
        }
      } finally {
        releaseDriftCleanupLock();
      }
    }
  }
  /** @type {boolean} */
  let servicesAreRunning;
  try {
    servicesAreRunning = serviceDefinitions().every((definition) => {
      const record = readPidRecord(definition);
      return (
        record !== null &&
        processExists(record.pid) &&
        isOwnedProcess(definition, record) &&
        record.artifactDigest === desiredArtifactDigest(definition)
      );
    });
  } catch {
    console.error('INTEGRATION_RESTORE_REQUIRED reason=service-state-uninspectable');
    servicesAreRunning = false;
  }
  if (!servicesAreRunning) {
    const restoreResult = spawnSync('npm', ['run', 'dev:up'], {
      cwd: REPOSITORY_ROOT,
      env: withRepositoryNpmCache(process.env),
      stdio: 'inherit',
    });
    if (restoreResult.status !== 0) {
      console.error(`INTEGRATION_RESTORE_FAILED exit=${String(restoreResult.status)}`);
    }
  }
}
