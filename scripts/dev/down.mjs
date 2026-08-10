import { existsSync } from 'node:fs';

import {
  acquireLifecycleLock,
  pidRecordPath,
  readPidRecord,
  removePidRecord,
  runPreflight,
  serviceDefinitions,
  stopOwnedRecord,
} from './lib.mjs';

const errors = [];
let releaseLifecycleLock = null;

try {
  releaseLifecycleLock = acquireLifecycleLock('down');
  const definitions = serviceDefinitions();
  for (const definition of [...definitions].reverse()) {
    const record = readPidRecord(definition);
    if (record === null) {
      if (existsSync(pidRecordPath(definition.id))) {
        throw new Error(`PID_RECORD_INVALID service=${definition.id}`);
      }
      removePidRecord(definition.id);
      continue;
    }

    try {
      await stopOwnedRecord(definition, record);
      console.log(`dev:down stopped service=${definition.id} pid=${record.pid}`);
    } catch (error) {
      errors.push(error);
    }
  }

  runPreflight();
} catch (error) {
  errors.push(error);
} finally {
  releaseLifecycleLock?.();
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
} else {
  console.log('dev:down complete repository=hack-for-humanity-summer-2026');
}
