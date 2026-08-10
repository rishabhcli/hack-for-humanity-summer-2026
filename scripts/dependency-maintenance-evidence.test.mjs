import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MAX_SNAPSHOT_AGE_DAYS,
  MILLISECONDS_PER_DAY,
  directDependenciesOf,
  elapsedWholeDays,
  maintenanceWindow,
  normalizeEvidence,
  normalizeRepositoryUrl,
  serializeEvidence,
  validateMaintenanceEvidence,
} from './dependency-maintenance-evidence.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
const committedText = readFileSync(
  resolve(repositoryRoot, 'evidence', 'tier-0', 'dependency-maintenance.json'),
  'utf8',
);
const committed = JSON.parse(committedText);
const directDependencies = directDependenciesOf(manifest);

/** Evaluate the committed snapshot as if "now" were one day after it was taken. */
const justAfterSnapshot = Date.parse(committed.snapshotAt) + MILLISECONDS_PER_DAY;

/** @param {(draft: any) => void} mutate @returns {{evidence: unknown, serialized: string}} */
function tamper(mutate) {
  const draft = JSON.parse(committedText);
  mutate(draft);
  const evidence = normalizeEvidence(draft);
  return { evidence, serialized: serializeEvidence(evidence) };
}

/** @param {(draft: any) => void} mutate @param {string} code @returns {void} */
function expectRejection(mutate, code) {
  const { evidence, serialized } = tamper(mutate);
  expect(() =>
    validateMaintenanceEvidence(evidence, serialized, {
      directDependencies,
      nowMilliseconds: justAfterSnapshot,
      repository: manifest.name,
    }),
  ).toThrow(new RegExp(code, 'u'));
}

describe('offline dependency-maintenance snapshot validation', () => {
  it('accepts the committed snapshot without any network access', () => {
    const summary = validateMaintenanceEvidence(committed, committedText, {
      directDependencies,
      nowMilliseconds: justAfterSnapshot,
      repository: manifest.name,
    });
    expect(summary.directDependencyCount).toBe(directDependencies.length);
    expect(summary.snapshotAgeDays).toBe(1);
    expect(summary.snapshotAt).toBe(committed.snapshotAt);
  });

  it('rejects a snapshot older than the declared freshness bound', () => {
    const expiredNow =
      Date.parse(committed.snapshotAt) + (MAX_SNAPSHOT_AGE_DAYS + 1) * MILLISECONDS_PER_DAY;
    expect(() =>
      validateMaintenanceEvidence(committed, committedText, {
        directDependencies,
        nowMilliseconds: expiredNow,
        repository: manifest.name,
      }),
    ).toThrow(/DEPENDENCY_MAINTENANCE_SNAPSHOT_EXPIRED/u);
  });

  it('rejects a snapshot timestamped in the future', () => {
    expect(() =>
      validateMaintenanceEvidence(committed, committedText, {
        directDependencies,
        nowMilliseconds: Date.parse(committed.snapshotAt) - MILLISECONDS_PER_DAY,
        repository: manifest.name,
      }),
    ).toThrow(/DEPENDENCY_MAINTENANCE_SNAPSHOT_IN_FUTURE/u);
  });

  it('rejects bytes that are not the canonical serialization', () => {
    expect(() =>
      validateMaintenanceEvidence(committed, `${committedText}\n`, {
        directDependencies,
        nowMilliseconds: justAfterSnapshot,
        repository: manifest.name,
      }),
    ).toThrow(/DEPENDENCY_MAINTENANCE_EVIDENCE_NOT_CANONICAL/u);
  });

  it('rejects a dependency set that does not match package.json', () => {
    expect(() =>
      validateMaintenanceEvidence(committed, committedText, {
        directDependencies: directDependencies.slice(1),
        nowMilliseconds: justAfterSnapshot,
        repository: manifest.name,
      }),
    ).toThrow(/DEPENDENCY_MAINTENANCE_DIRECT_COUNT_MISMATCH/u);
  });

  it('rejects a recorded version that drifted from the manifest', () => {
    const drifted = directDependencies.map((dependency, index) =>
      index === 0 ? { ...dependency, version: '0.0.0-drift' } : dependency,
    );
    expect(() =>
      validateMaintenanceEvidence(committed, committedText, {
        directDependencies: drifted,
        nowMilliseconds: justAfterSnapshot,
        repository: manifest.name,
      }),
    ).toThrow(/DEPENDENCY_MAINTENANCE_DEPENDENCY_SET_MISMATCH/u);
  });

  it('recomputes the release age instead of trusting the recorded one', () => {
    expectRejection((draft) => {
      draft.dependencies[0].registry.maintenanceObservation.ageDaysAtSnapshot += 5;
    }, 'DEPENDENCY_MAINTENANCE_OBSERVATION_AGE_INCONSISTENT');
  });

  it('recomputes the maintenance bucket instead of trusting the recorded one', () => {
    expectRejection((draft) => {
      draft.dependencies[0].registry.maintenanceObservation.status =
        'no-stable-release-published-within-365-days';
    }, 'DEPENDENCY_MAINTENANCE_OBSERVATION_STATUS_INCONSISTENT');
  });

  it('rejects a registry timestamp recorded after the snapshot was taken', () => {
    expectRejection((draft) => {
      draft.dependencies[0].registry.registryModifiedAt = new Date(
        Date.parse(committed.snapshotAt) + MILLISECONDS_PER_DAY,
      ).toISOString();
    }, 'DEPENDENCY_MAINTENANCE_TIMESTAMP_AFTER_SNAPSHOT');
  });

  it('fails closed on a deprecated locked version', () => {
    expectRejection((draft) => {
      draft.dependencies[0].registry.deprecation = 'no longer supported';
    }, 'DEPENDENCY_MAINTENANCE_LOCKED_VERSION_DEPRECATED');
  });

  it('fails closed on an advisory affecting the locked version that was never withdrawn', () => {
    expectRejection((draft) => {
      const advisory = {
        aliases: ['CVE-2026-0000'],
        exactVersionAffected: true,
        id: 'GHSA-test-test-test',
        modifiedAt: committed.snapshotAt,
        publishedAt: committed.snapshotAt,
        withdrawnAt: null,
      };
      draft.dependencies[0].advisories.exactVersionAffectedAdvisories = [advisory];
      draft.dependencies[0].advisories.returnedIds = [advisory.id];
      draft.dependencies[0].advisories.knownAffectedAtSnapshot = true;
    }, 'DEPENDENCY_MAINTENANCE_ADVISORY_UNRESOLVED');
  });

  it('rejects an advisory summary that disagrees with the advisory list', () => {
    expectRejection((draft) => {
      draft.dependencies[0].advisories.knownAffectedAtSnapshot = true;
    }, 'DEPENDENCY_MAINTENANCE_ADVISORY_FLAG_INCONSISTENT');
  });

  it('rejects an advisory query that does not name the locked dependency', () => {
    expectRejection((draft) => {
      draft.dependencies[0].advisories.query.version = '0.0.0-other';
    }, 'DEPENDENCY_MAINTENANCE_ADVISORY_QUERY_MISMATCH');
  });

  it('rejects a repository url that was not derived from the registry value', () => {
    expectRejection((draft) => {
      draft.dependencies[0].registry.repository.url = 'https://github.com/attacker/typosquat';
    }, 'DEPENDENCY_MAINTENANCE_REPOSITORY_URL_INCONSISTENT');
  });

  it('rejects a registry endpoint pointing away from the npm registry', () => {
    expectRejection((draft) => {
      draft.dependencies[0].registry.registryEndpoint = 'https://registry.example.invalid/pkg';
    }, 'DEPENDENCY_MAINTENANCE_REGISTRY_ENDPOINT_MISMATCH');
  });

  it('rejects an unsupported schema version', () => {
    expectRejection((draft) => {
      draft.schemaVersion = 2;
    }, 'DEPENDENCY_MAINTENANCE_SCHEMA_VERSION_UNSUPPORTED');
  });

  it('rejects a rewritten maintenance bucket policy', () => {
    expectRejection((draft) => {
      draft.maintenanceStatusPolicy.buckets = ['always-maintained'];
    }, 'DEPENDENCY_MAINTENANCE_POLICY_BUCKETS_UNEXPECTED');
  });
});

describe('maintenance window derivation', () => {
  it('maps elapsed days onto the declared buckets at each boundary', () => {
    expect(maintenanceWindow(0)).toBe('latest-stable-published-within-90-days');
    expect(maintenanceWindow(90)).toBe('latest-stable-published-within-90-days');
    expect(maintenanceWindow(91)).toBe('latest-stable-published-within-180-days');
    expect(maintenanceWindow(180)).toBe('latest-stable-published-within-180-days');
    expect(maintenanceWindow(181)).toBe('latest-stable-published-within-365-days');
    expect(maintenanceWindow(365)).toBe('latest-stable-published-within-365-days');
    expect(maintenanceWindow(366)).toBe('no-stable-release-published-within-365-days');
  });

  it('never reports a negative age', () => {
    expect(elapsedWholeDays('2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')).toBe(0);
    expect(elapsedWholeDays('2026-01-03T00:00:00.000Z', '2026-01-01T00:00:00.000Z')).toBe(2);
  });
});

describe('repository url normalization', () => {
  it('normalizes the git url forms npm actually publishes', () => {
    for (const raw of [
      'git+https://github.com/example/project.git',
      'git://github.com/example/project.git',
      'ssh://git@github.com/example/project.git',
      'git@github.com:example/project.git',
    ]) {
      expect(normalizeRepositoryUrl(raw)).toBe('https://github.com/example/project');
    }
  });

  it('refuses a non-https repository target', () => {
    expect(() => normalizeRepositoryUrl('http://github.com/example/project')).toThrow(
      /DEPENDENCY_REPOSITORY_PROTOCOL_UNSUPPORTED/u,
    );
  });
});
