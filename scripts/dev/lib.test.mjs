import fc from 'fast-check';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  REPOSITORY_ROOT,
  acquireLifecycleLock,
  directoryDigest,
  ensureDevDirectories,
  expectedProcessCommand,
  fileDigest,
  formatErrorChain,
  processAbsent,
  releaseStaleRecord,
  isValidPidRecord,
  isExclusiveLoopbackListener,
  parseLsofListenerRecords,
  parsePortsEnv,
  serviceDefinitions,
} from './lib.mjs';

const validConfig = `
# isolated block
PORT_0=4180 # pwa
PORT_1=4181 # preview
PORT_2=4182 # playwright
PORT_3=4183 # fixtures
`;

describe('parallel development port contract', () => {
  it('parses the committed isolated port allocation', () => {
    expect(parsePortsEnv(validConfig)).toEqual({
      PORT_0: 4180,
      PORT_1: 4181,
      PORT_2: 4182,
      PORT_3: 4183,
    });
  });

  it.each([
    `${validConfig}\nPORT_0=4184`,
    validConfig.replace('PORT_3=4183', 'PORT_3=5173'),
    validConfig.replace('PORT_3=4183', 'PORT_3=4182'),
    validConfig.replace('PORT_3=4183', ''),
    `${validConfig}\nnot-an-assignment`,
    `${validConfig}\nPORT_4=4184`,
  ])('rejects an unsafe or ambiguous allocation', (config) => {
    expect(() => parsePortsEnv(config)).toThrow();
  });

  it('round-trips every unique four-port allocation inside the exclusive block (250 cases)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 4180, max: 4189 }), {
          maxLength: 4,
          minLength: 4,
        }),
        (ports) => {
          const config = ports.map((port, index) => `PORT_${index}=${port}`).join('\n');
          expect(parsePortsEnv(config)).toEqual({
            PORT_0: ports[0],
            PORT_1: ports[1],
            PORT_2: ports[2],
            PORT_3: ports[3],
          });
        },
      ),
      { numRuns: 250, seed: 20260809 },
    );
  });
});

describe('PID ownership record schema', () => {
  const definition = serviceDefinitions(parsePortsEnv(validConfig))[0];
  if (definition === undefined) {
    throw new Error('TEST_SERVICE_DEFINITION_MISSING');
  }
  const validRecord = {
    artifactDigest: 'a'.repeat(64),
    certificateDigest: 'b'.repeat(64),
    configDigest: 'c'.repeat(64),
    host: '127.0.0.1',
    ownershipToken: 'd'.repeat(64),
    pid: 12_345,
    port: definition.port,
    processCommand: expectedProcessCommand(definition),
    processStart: 'Mon Aug 10 00:00:00 2026',
    readinessSecret: 'e'.repeat(64),
    repositoryRoot: REPOSITORY_ROOT,
    runId: '00000000-0000-4000-8000-000000000000',
    schemaVersion: 2,
    service: definition.id,
    startedAt: '2026-08-10T07:00:00.000Z',
  };

  it('accepts the exact versioned record written by the lifecycle', () => {
    expect(isValidPidRecord(definition, validRecord)).toBe(true);
  });

  it.each([
    { host: '0.0.0.0' },
    { ownershipToken: 'short' },
    { pid: 1 },
    { port: 4189 },
    { processCommand: '/usr/bin/node unrelated-process.mjs' },
    { runId: 'not-a-uuid' },
    { schemaVersion: 1 },
    { service: 'preview' },
    { service: '../../foreign' },
  ])('rejects a forged or mismatched field %#', (change) => {
    expect(isValidPidRecord(definition, { ...validRecord, ...change })).toBe(false);
  });

  it('rejects unknown fields rather than accepting schema drift', () => {
    expect(isValidPidRecord(definition, { ...validRecord, unexpected: true })).toBe(false);
  });
});

describe('lifecycle lock ownership', () => {
  const lockPath = join(REPOSITORY_ROOT, '.dev', 'pids', 'lifecycle.lock');

  it('serializes contenders and refuses a release after lock identity changes', () => {
    const release = acquireLifecycleLock('unit-lock-owner', 1_000);
    const original = readFileSync(lockPath, 'utf8');
    const record = JSON.parse(original);

    try {
      expect(() => acquireLifecycleLock('unit-lock-contender', 150)).toThrow(
        'LIFECYCLE_LOCK_TIMEOUT',
      );
      writeFileSync(
        lockPath,
        `${JSON.stringify({ ...record, token: '00000000-0000-4000-8000-000000000000' })}\n`,
        'utf8',
      );
      expect(release).toThrow('LIFECYCLE_LOCK_RELEASE_REFUSED');
      expect(existsSync(lockPath)).toBe(true);
      writeFileSync(lockPath, original, 'utf8');
      release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      if (existsSync(lockPath)) {
        writeFileSync(lockPath, original, 'utf8');
        try {
          release();
        } catch {
          rmSync(lockPath, { force: true });
        }
      }
    }
  });
});

describe('repository path confinement', () => {
  it('refuses file and directory digests that encounter a symlink', () => {
    ensureDevDirectories();
    const fixtureRoot = mkdtempSync(join(REPOSITORY_ROOT, '.dev', 'tmp', 'digest-symlink-'));
    const realDirectory = join(fixtureRoot, 'real');
    const realFile = join(realDirectory, 'sentinel.txt');
    const linkPath = join(fixtureRoot, 'sentinel-link');
    mkdirSync(realDirectory);
    writeFileSync(realFile, 'repository-local sentinel\n', 'utf8');
    symlinkSync(realFile, linkPath);

    try {
      expect(() => fileDigest(linkPath)).toThrow('DIGEST_FILE_INVALID');
      expect(() => directoryDigest(fixtureRoot)).toThrow('DIGEST_SYMLINK_REFUSED');
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });
});

describe('listener inspection', () => {
  it('requires every listener socket to be the expected PID and IPv4 loopback binding', () => {
    const records = parseLsofListenerRecords(
      'p12345\nf16\nn127.0.0.1:4180\nf17\nn*:4180\np12346\nf18\nn[::1]:4180\n',
    );

    expect(records).toEqual([
      { name: '127.0.0.1:4180', pid: 12_345 },
      { name: '*:4180', pid: 12_345 },
      { name: '[::1]:4180', pid: 12_346 },
    ]);
    expect(
      isExclusiveLoopbackListener([{ name: '127.0.0.1:4180', pid: 12_345 }], 12_345, 4180),
    ).toBe(true);
    expect(isExclusiveLoopbackListener(records.slice(0, 2), 12_345, 4180)).toBe(false);
    expect(isExclusiveLoopbackListener(records, 12_345, 4180)).toBe(false);
  });
});

describe('readiness failure diagnostics', () => {
  it('flattens a cause chain so a readiness failure names its underlying reason', () => {
    const root = new Error('ECONNREFUSED 127.0.0.1:4181');
    const middle = new Error('DEV_APPLICATION_TIMEOUT service=preview', { cause: root });
    const outer = new Error('DEV_HEALTH_DEADLINE service=preview attempts=5', { cause: middle });

    expect(formatErrorChain(outer)).toBe(
      'DEV_HEALTH_DEADLINE service=preview attempts=5 <- DEV_APPLICATION_TIMEOUT service=preview <- ECONNREFUSED 127.0.0.1:4181',
    );
  });

  it('terminates on a self-referencing cause instead of looping forever', () => {
    const looping = new Error('DEV_HEALTH_DEADLINE service=pwa');
    looping.cause = looping;

    expect(formatErrorChain(looping).split(' <- ')).toHaveLength(8);
  });

  it('describes a non-error rejection rather than printing an empty message', () => {
    expect(formatErrorChain('socket hang up')).toBe('socket hang up');
    expect(formatErrorChain(undefined)).toBe('');
  });
});

describe('crash cleanup is idempotent', () => {
  it('reports absence only for a PID the operating system says is gone', () => {
    expect(processAbsent(process.pid)).toBe(false);
    // PID 1 exists on every POSIX host and is not ours: kill(0) yields EPERM, not ESRCH. Treating
    // that as absence would let this repository forget a process it can still see.
    expect(processAbsent(1)).toBe(false);
    expect(processAbsent(0x7ff_ffff)).toBe(true);
  });

  it('refuses to release a record whose process is still alive', () => {
    const [liveDefinition] = serviceDefinitions(parsePortsEnv(validConfig));
    if (liveDefinition === undefined) {
      throw new Error('TEST_SERVICE_DEFINITION_MISSING');
    }

    // No record file is touched: a live PID short-circuits before removal is even considered.
    expect(
      releaseStaleRecord(liveDefinition, {
        artifactDigest: 'a'.repeat(64),
        certificateDigest: 'b'.repeat(64),
        configDigest: 'c'.repeat(64),
        host: '127.0.0.1',
        ownershipToken: 'd'.repeat(64),
        pid: process.pid,
        port: liveDefinition.port,
        processCommand: expectedProcessCommand(liveDefinition),
        processStart: 'Mon Aug 10 00:00:00 2026',
        readinessSecret: 'e'.repeat(64),
        repositoryRoot: REPOSITORY_ROOT,
        runId: '00000000-0000-4000-8000-000000000000',
        schemaVersion: 2,
        service: liveDefinition.id,
        startedAt: '2026-08-10T07:00:00.000Z',
      }),
    ).toBe(false);
  });
});
