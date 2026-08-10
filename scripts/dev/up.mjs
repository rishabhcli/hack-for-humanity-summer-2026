import {
  CERTIFICATE_PATH,
  acquireLifecycleLock,
  configurationDigest,
  createRunIdentity,
  desiredArtifactDigest,
  ensureCertificate,
  fileDigest,
  formatErrorChain,
  healthRequest,
  isOwnedProcess,
  listenerPids,
  readPidRecord,
  runPreflight,
  serviceDefinitions,
  stopOwnedRecord,
  waitForHealth,
} from './lib.mjs';
import { ensureCurrentBuild } from './build.mjs';
import { startService } from './start-service.mjs';

/** @typedef {NonNullable<ReturnType<typeof readPidRecord>>} PidRecord */
/** @type {PidRecord[]} */
const startedRecords = [];
/** @type {null | (() => void)} */
let releaseLifecycleLock = null;

try {
  releaseLifecycleLock = acquireLifecycleLock('up');
  const { definitions } = runPreflight();
  ensureCertificate();
  ensureCurrentBuild();

  const configDigest = configurationDigest();
  const certificateDigest = fileDigest(CERTIFICATE_PATH);
  for (const definition of definitions) {
    const expectedArtifactDigest = desiredArtifactDigest(definition);
    const record = readPidRecord(definition);
    const listeners = listenerPids(definition.port);
    if (
      record !== null &&
      isOwnedProcess(definition, record) &&
      record.artifactDigest === expectedArtifactDigest &&
      record.certificateDigest === certificateDigest &&
      record.configDigest === configDigest &&
      listeners.length === 1 &&
      listeners[0] === record.pid
    ) {
      try {
        await healthRequest(definition);
        console.log(`dev:up retained service=${definition.id} pid=${record.pid}`);
        continue;
      } catch {
        await stopOwnedRecord(definition, record);
      }
    } else if (record !== null && isOwnedProcess(definition, record)) {
      await stopOwnedRecord(definition, record);
    }

    const runIdentity = createRunIdentity();
    const newRecord = await startService(definition, {
      ...runIdentity,
      artifactDigest: expectedArtifactDigest,
      certificateDigest,
      configDigest,
    });
    startedRecords.push(newRecord);
    console.log(
      `dev:up started service=${definition.id} pid=${newRecord.pid} port=${definition.port}`,
    );
  }

  for (const definition of definitions) {
    await waitForHealth(definition);
  }
  console.log('dev:up ready repository=hack-for-humanity-summer-2026');
} catch (error) {
  console.error(formatErrorChain(error));
  for (const record of [...startedRecords].reverse()) {
    try {
      const definition = serviceDefinitions().find((candidate) => candidate.id === record.service);
      if (definition !== undefined && isOwnedProcess(definition, record)) {
        await stopOwnedRecord(definition, record);
      }
    } catch (cleanupError) {
      console.error(formatErrorChain(cleanupError));
    }
  }
  process.exitCode = 1;
} finally {
  releaseLifecycleLock?.();
}
