import { spawn } from 'node:child_process';

import {
  REPOSITORY_ROOT,
  processCommand,
  processExists,
  processStart,
  serviceCommand,
  serviceLogDescriptor,
  writePidRecord,
} from './lib.mjs';

/** @typedef {ReturnType<import('./lib.mjs').readPidRecord>} MaybePidRecord */
/** @typedef {NonNullable<MaybePidRecord>} PidRecord */
/** @typedef {ReturnType<import('./lib.mjs').serviceDefinitions>[number]} ServiceDefinition */
/**
 * @typedef ServiceIdentity
 * @property {string} artifactDigest
 * @property {string} certificateDigest
 * @property {string} configDigest
 * @property {string} ownershipToken
 * @property {string} readinessSecret
 * @property {string} runId
 */

/** @param {number} pid @param {number} timeoutMs @returns {Promise<void>} */
async function waitForSpawnedExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

/** @param {number} pid @param {string | null} expectedStart @returns {Promise<void>} */
async function stopJustSpawnedProcess(pid, expectedStart) {
  if (!processExists(pid)) {
    return;
  }
  if (expectedStart !== null && processStart(pid) !== expectedStart) {
    throw new Error(`DEV_SERVICE_START_CLEANUP_PID_REUSED pid=${pid}`);
  }

  process.kill(pid, 'SIGTERM');
  await waitForSpawnedExit(pid, 2_000);
  if (processExists(pid)) {
    if (expectedStart === null || processStart(pid) !== expectedStart) {
      throw new Error(`DEV_SERVICE_START_CLEANUP_PID_UNCERTAIN pid=${pid}`);
    }
    process.kill(pid, 'SIGKILL');
    await waitForSpawnedExit(pid, 2_000);
  }
  if (processExists(pid)) {
    throw new Error(`DEV_SERVICE_START_CLEANUP_UNCONFIRMED pid=${pid}`);
  }
}

/**
 * @param {ServiceDefinition} definition
 * @param {ServiceIdentity} identity
 * @param {(pid: number) => (void | Promise<void>)} [afterSpawn]
 * @returns {Promise<PidRecord>}
 */
export async function startService(definition, identity, afterSpawn = () => undefined) {
  const command = serviceCommand(definition);
  const log = serviceLogDescriptor(definition.id);
  const inheritedEnvironment = Object.fromEntries(
    ['HOME', 'LANG', 'LC_ALL', 'NO_COLOR', 'PATH', 'TMPDIR'].flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
  /** @type {number | null} */
  let childPid = null;
  /** @type {string | null} */
  let signature = null;

  try {
    const child = spawn(command.command, command.args, {
      cwd: REPOSITORY_ROOT,
      detached: true,
      env: {
        ...inheritedEnvironment,
        ...command.environment,
        DEV_SERVICE_NAME: definition.id,
        DEV_SERVICE_PORT: String(definition.port),
        DEV_ARTIFACT_DIGEST: identity.artifactDigest,
        DEV_CERTIFICATE_DIGEST: identity.certificateDigest,
        DEV_CONFIG_DIGEST: identity.configDigest,
        DEV_OWNERSHIP_TOKEN: identity.ownershipToken,
        DEV_READINESS_SECRET: identity.readinessSecret,
        DEV_RUN_ID: identity.runId,
      },
      stdio: ['ignore', log.descriptor, log.descriptor],
    });
    child.unref();
    if (child.pid === undefined) {
      throw new Error(`DEV_SERVICE_PID_MISSING service=${definition.id}`);
    }
    childPid = child.pid;

    const startDeadline = Date.now() + 2_000;
    signature = processStart(childPid);
    while (signature === null && Date.now() < startDeadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      signature = processStart(childPid);
    }
    if (signature === null) {
      throw new Error(`DEV_SERVICE_START_FAILED service=${definition.id}`);
    }
    const commandLine = processCommand(childPid);
    if (commandLine === null) {
      throw new Error(`DEV_SERVICE_COMMAND_UNAVAILABLE service=${definition.id}`);
    }

    await afterSpawn(childPid);
    const record = {
      artifactDigest: identity.artifactDigest,
      certificateDigest: identity.certificateDigest,
      configDigest: identity.configDigest,
      host: '127.0.0.1',
      ownershipToken: identity.ownershipToken,
      pid: childPid,
      port: definition.port,
      processCommand: commandLine,
      processStart: signature,
      readinessSecret: identity.readinessSecret,
      repositoryRoot: REPOSITORY_ROOT,
      runId: identity.runId,
      schemaVersion: 2,
      service: definition.id,
      startedAt: new Date().toISOString(),
    };
    writePidRecord(definition, record);
    return record;
  } catch (error) {
    if (childPid !== null) {
      try {
        await stopJustSpawnedProcess(childPid, signature);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `DEV_SERVICE_START_CLEANUP_FAILED service=${definition.id} pid=${childPid}`,
          { cause: cleanupError },
        );
      }
    }
    throw error;
  } finally {
    log.close();
  }
}
