import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { createRunIdentity, ensureCertificate, listenerPids, processExists } from './lib.mjs';
import { startService } from './start-service.mjs';

describe('detached service startup failure cleanup', () => {
  it('sanitizes inherited secrets and reaps a child when startup faults before PID recording', async () => {
    ensureCertificate();
    const definition = /** @type {ReturnType<import('./lib.mjs').serviceDefinitions>[number]} */ ({
      id: 'fixtures',
      label: 'fault-injection fixture service',
      port: 4188,
    });
    const identity = {
      ...createRunIdentity(),
      artifactDigest: 'a'.repeat(64),
      certificateDigest: 'b'.repeat(64),
      configDigest: 'c'.repeat(64),
    };
    let spawnedPid = null;
    process.env['DEV_FAULT_PARENT_SECRET'] = 'must-not-reach-child';
    try {
      await expect(
        startService(definition, identity, (pid) => {
          spawnedPid = pid;
          const processEnvironment = execFileSync(
            'ps',
            ['eww', '-p', String(pid), '-o', 'command='],
            { encoding: 'utf8' },
          );
          expect(processEnvironment).not.toContain('DEV_FAULT_PARENT_SECRET');
          throw new Error('INJECTED_FAILURE_AFTER_SPAWN');
        }),
      ).rejects.toThrow('INJECTED_FAILURE_AFTER_SPAWN');
    } finally {
      delete process.env['DEV_FAULT_PARENT_SECRET'];
    }

    expect(spawnedPid).not.toBeNull();
    expect(spawnedPid === null ? false : processExists(spawnedPid)).toBe(false);
    expect(listenerPids(definition.port)).toEqual([]);
  });
});
