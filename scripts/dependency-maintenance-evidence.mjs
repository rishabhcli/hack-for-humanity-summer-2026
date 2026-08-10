import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPOSITORY_ROOT } from './npm-environment.mjs';

export const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org';
export const OSV_QUERY_URL = 'https://api.osv.dev/v1/query';
export const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * The committed snapshot is the immutable input this gate validates against. The npm registry and
 * the OSV database are mutable third parties, so re-querying them inside `--check` would make
 * `verify-all` fail whenever an unrelated upstream package publishes. Freshness is instead bounded
 * by this maximum age, which depends only on the committed timestamp and the current clock.
 */
export const MAX_SNAPSHOT_AGE_DAYS = 30;

export const MAINTENANCE_BUCKETS = [
  'latest-stable-published-within-90-days',
  'latest-stable-published-within-180-days',
  'latest-stable-published-within-365-days',
  'no-stable-release-published-within-365-days',
];

export const EVIDENCE_COMMAND = 'npm run evidence:dependency-maintenance';
export const SCHEMA_VERSION = 1;

const NETWORK_TIMEOUT_MS = 30_000;
const REGISTRY_RESPONSE_LIMIT_BYTES = 64 * 1024 * 1024;
const OSV_RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;
const MAX_OSV_PAGES = 20;
const REGISTRY_CONCURRENCY = 3;

/** @typedef {Record<string, unknown>} JsonObject */
/**
 * @typedef DirectDependency
 * @property {string} name
 * @property {string} version
 */

/** @param {unknown} value @param {string} code @returns {JsonObject} */
export function requireObject(value, code) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(code);
  }
  return /** @type {JsonObject} */ (value);
}

/** @param {unknown} value @param {string} code @returns {unknown[]} */
export function requireArray(value, code) {
  if (!Array.isArray(value)) {
    throw new Error(code);
  }
  return value;
}

/** @param {unknown} value @param {string} code @returns {string} */
export function requireString(value, code) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(code);
  }
  return value;
}

/** @param {unknown} value @param {string} code @returns {string | null} */
export function requireNullableString(value, code) {
  if (value === null) {
    return null;
  }
  return requireString(value, code);
}

/** @param {unknown} value @param {string} code @returns {boolean} */
export function requireBoolean(value, code) {
  if (typeof value !== 'boolean') {
    throw new Error(code);
  }
  return value;
}

/** @param {unknown} value @param {string} code @returns {number} */
export function requireNonNegativeInteger(value, code) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(code);
  }
  return value;
}

/** @param {unknown} value @param {string} code @returns {string} */
export function requireTimestamp(value, code) {
  const timestamp = requireString(value, code);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(code);
  }
  return timestamp;
}

/** @param {unknown} value @param {string} code @returns {string | null} */
export function requireNullableTimestamp(value, code) {
  if (value === null) {
    return null;
  }
  return requireTimestamp(value, code);
}

/** @param {string} rawUrl @returns {string} */
export function normalizeRepositoryUrl(rawUrl) {
  let normalized = rawUrl.trim().replace(/^git\+/u, '');
  normalized = normalized.replace(/^git:\/\/github\.com\//u, 'https://github.com/');
  normalized = normalized.replace(/^ssh:\/\/git@github\.com\//u, 'https://github.com/');
  normalized = normalized.replace(/^git@github\.com:/u, 'https://github.com/');
  normalized = normalized.replace(/\.git$/u, '');
  const url = new URL(normalized);
  if (url.protocol !== 'https:') {
    throw new Error(`DEPENDENCY_REPOSITORY_PROTOCOL_UNSUPPORTED protocol=${url.protocol}`);
  }
  return url.toString().replace(/\/$/u, '');
}

/** @param {number} ageDays @returns {string} */
export function maintenanceWindow(ageDays) {
  if (ageDays <= 90) {
    return 'latest-stable-published-within-90-days';
  }
  if (ageDays <= 180) {
    return 'latest-stable-published-within-180-days';
  }
  if (ageDays <= 365) {
    return 'latest-stable-published-within-365-days';
  }
  return 'no-stable-release-published-within-365-days';
}

/** @param {string} snapshotAt @param {string} publishedAt @returns {number} */
export function elapsedWholeDays(snapshotAt, publishedAt) {
  return Math.max(
    0,
    Math.floor((Date.parse(snapshotAt) - Date.parse(publishedAt)) / MILLISECONDS_PER_DAY),
  );
}

/** @param {unknown} value @returns {unknown} */
export function normalizeEvidence(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeEvidence(entry));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(/** @type {JsonObject} */ (value))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeEvidence(entry)]),
    );
  }
  return value;
}

/** @param {unknown} evidence @returns {string} */
export function serializeEvidence(evidence) {
  return `${JSON.stringify(evidence, null, 2)}\n`;
}

/** @param {{devDependencies?: Record<string, string>}} manifest @returns {DirectDependency[]} */
export function directDependenciesOf(manifest) {
  const dependencies = Object.entries(manifest.devDependencies ?? {})
    .map(([name, version]) => ({ name, version }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (dependencies.length === 0) {
    throw new Error('DEPENDENCY_MAINTENANCE_DIRECT_SET_EMPTY');
  }
  return dependencies;
}

/**
 * Validates a committed maintenance snapshot without any network access.
 *
 * Every derived field is recomputed from the snapshot's own recorded timestamps, so a hand-edited
 * age, status bucket, or advisory summary fails here rather than being trusted.
 *
 * @param {unknown} rawEvidence parsed committed artifact
 * @param {string} serializedText exact bytes of the committed artifact
 * @param {{directDependencies: DirectDependency[], nowMilliseconds: number, repository: string}} expected
 * @returns {{directDependencyCount: number, snapshotAgeDays: number, snapshotAt: string}}
 */
export function validateMaintenanceEvidence(rawEvidence, serializedText, expected) {
  const evidence = requireObject(rawEvidence, 'DEPENDENCY_MAINTENANCE_EVIDENCE_INVALID');

  if (serializeEvidence(normalizeEvidence(evidence)) !== serializedText) {
    throw new Error(`DEPENDENCY_MAINTENANCE_EVIDENCE_NOT_CANONICAL run="${EVIDENCE_COMMAND}"`);
  }
  if (evidence['schemaVersion'] !== SCHEMA_VERSION) {
    throw new Error('DEPENDENCY_MAINTENANCE_SCHEMA_VERSION_UNSUPPORTED');
  }
  if (evidence['command'] !== EVIDENCE_COMMAND) {
    throw new Error('DEPENDENCY_MAINTENANCE_COMMAND_MISMATCH');
  }
  if (evidence['repository'] !== expected.repository) {
    throw new Error('DEPENDENCY_MAINTENANCE_REPOSITORY_MISMATCH');
  }
  requireString(evidence['securityHistoryScope'], 'DEPENDENCY_MAINTENANCE_SECURITY_SCOPE_MISSING');

  const policy = requireObject(
    evidence['maintenanceStatusPolicy'],
    'DEPENDENCY_MAINTENANCE_POLICY_MISSING',
  );
  const buckets = requireArray(policy['buckets'], 'DEPENDENCY_MAINTENANCE_POLICY_BUCKETS_INVALID');
  if (JSON.stringify(buckets) !== JSON.stringify(MAINTENANCE_BUCKETS)) {
    throw new Error('DEPENDENCY_MAINTENANCE_POLICY_BUCKETS_UNEXPECTED');
  }
  requireString(policy['basis'], 'DEPENDENCY_MAINTENANCE_POLICY_BASIS_MISSING');
  requireString(policy['limitation'], 'DEPENDENCY_MAINTENANCE_POLICY_LIMITATION_MISSING');

  const sources = requireObject(evidence['sources'], 'DEPENDENCY_MAINTENANCE_SOURCES_MISSING');
  if (sources['osvQuery'] !== OSV_QUERY_URL) {
    throw new Error('DEPENDENCY_MAINTENANCE_SOURCE_OSV_MISMATCH');
  }
  if (sources['npmRegistry'] !== `${NPM_REGISTRY_ORIGIN}/<encoded-package-name>`) {
    throw new Error('DEPENDENCY_MAINTENANCE_SOURCE_REGISTRY_MISMATCH');
  }

  const snapshotAt = requireTimestamp(
    evidence['snapshotAt'],
    'DEPENDENCY_MAINTENANCE_SNAPSHOT_TIMESTAMP_INVALID',
  );
  const snapshotMilliseconds = Date.parse(snapshotAt);
  if (snapshotMilliseconds > expected.nowMilliseconds) {
    throw new Error(`DEPENDENCY_MAINTENANCE_SNAPSHOT_IN_FUTURE snapshot=${snapshotAt}`);
  }
  const snapshotAgeDays = Math.floor(
    (expected.nowMilliseconds - snapshotMilliseconds) / MILLISECONDS_PER_DAY,
  );
  if (snapshotAgeDays > MAX_SNAPSHOT_AGE_DAYS) {
    throw new Error(
      `DEPENDENCY_MAINTENANCE_SNAPSHOT_EXPIRED ageDays=${String(snapshotAgeDays)} limit=${String(MAX_SNAPSHOT_AGE_DAYS)} run="${EVIDENCE_COMMAND}"`,
    );
  }

  const recorded = requireArray(
    evidence['dependencies'],
    'DEPENDENCY_MAINTENANCE_DEPENDENCIES_MISSING',
  );
  if (evidence['directDependencyCount'] !== expected.directDependencies.length) {
    throw new Error('DEPENDENCY_MAINTENANCE_DIRECT_COUNT_MISMATCH');
  }
  if (recorded.length !== expected.directDependencies.length) {
    throw new Error(
      `DEPENDENCY_MAINTENANCE_DEPENDENCY_SET_MISMATCH recorded=${String(recorded.length)} expected=${String(expected.directDependencies.length)}`,
    );
  }

  for (const [index, expectedDependency] of expected.directDependencies.entries()) {
    const entry = requireObject(
      recorded[index],
      `DEPENDENCY_MAINTENANCE_ENTRY_INVALID index=${String(index)}`,
    );
    const name = requireString(
      entry['name'],
      `DEPENDENCY_MAINTENANCE_NAME_MISSING index=${String(index)}`,
    );
    const version = requireString(
      entry['version'],
      `DEPENDENCY_MAINTENANCE_VERSION_MISSING name=${name}`,
    );
    if (name !== expectedDependency.name || version !== expectedDependency.version) {
      throw new Error(
        `DEPENDENCY_MAINTENANCE_DEPENDENCY_SET_MISMATCH recorded=${name}@${version} expected=${expectedDependency.name}@${expectedDependency.version}`,
      );
    }

    validateRegistryEntry(entry['registry'], { name, snapshotAt, version });
    validateAdvisoryEntry(entry['advisories'], { name, snapshotAt, version });
  }

  return {
    directDependencyCount: expected.directDependencies.length,
    snapshotAgeDays,
    snapshotAt,
  };
}

/** @param {unknown} rawRegistry @param {{name: string, snapshotAt: string, version: string}} context @returns {void} */
function validateRegistryEntry(rawRegistry, context) {
  const registry = requireObject(
    rawRegistry,
    `DEPENDENCY_MAINTENANCE_REGISTRY_MISSING name=${context.name}`,
  );

  const expectedEndpoint = `${NPM_REGISTRY_ORIGIN}/${encodeURIComponent(context.name)}`;
  if (registry['registryEndpoint'] !== expectedEndpoint) {
    throw new Error(`DEPENDENCY_MAINTENANCE_REGISTRY_ENDPOINT_MISMATCH name=${context.name}`);
  }

  const exactVersionPublishedAt = requireTimestamp(
    registry['exactVersionPublishedAt'],
    `DEPENDENCY_MAINTENANCE_EXACT_PUBLISHED_INVALID name=${context.name}`,
  );
  const registryModifiedAt = requireTimestamp(
    registry['registryModifiedAt'],
    `DEPENDENCY_MAINTENANCE_REGISTRY_MODIFIED_INVALID name=${context.name}`,
  );
  const snapshotMilliseconds = Date.parse(context.snapshotAt);
  if (Date.parse(exactVersionPublishedAt) > snapshotMilliseconds) {
    throw new Error(
      `DEPENDENCY_MAINTENANCE_TIMESTAMP_AFTER_SNAPSHOT name=${context.name} field=exactVersionPublishedAt`,
    );
  }
  if (Date.parse(registryModifiedAt) > snapshotMilliseconds) {
    throw new Error(
      `DEPENDENCY_MAINTENANCE_TIMESTAMP_AFTER_SNAPSHOT name=${context.name} field=registryModifiedAt`,
    );
  }

  // A deprecated locked version is a supply-chain finding, not a note: fail closed.
  if (
    requireNullableString(
      registry['deprecation'],
      `DEPENDENCY_MAINTENANCE_DEPRECATION_INVALID name=${context.name}`,
    ) !== null
  ) {
    throw new Error(
      `DEPENDENCY_MAINTENANCE_LOCKED_VERSION_DEPRECATED name=${context.name} version=${context.version}`,
    );
  }

  const latestStable = requireObject(
    registry['latestStable'],
    `DEPENDENCY_MAINTENANCE_LATEST_MISSING name=${context.name}`,
  );
  const latestVersion = requireString(
    latestStable['version'],
    `DEPENDENCY_MAINTENANCE_LATEST_VERSION_INVALID name=${context.name}`,
  );
  if (latestVersion.includes('-')) {
    throw new Error(`DEPENDENCY_MAINTENANCE_LATEST_NOT_STABLE name=${context.name}`);
  }
  requireNullableString(
    latestStable['deprecation'],
    `DEPENDENCY_MAINTENANCE_LATEST_DEPRECATION_INVALID name=${context.name}`,
  );
  const latestPublishedAt = requireTimestamp(
    latestStable['publishedAt'],
    `DEPENDENCY_MAINTENANCE_LATEST_PUBLISHED_INVALID name=${context.name}`,
  );
  if (Date.parse(latestPublishedAt) > Date.parse(context.snapshotAt)) {
    throw new Error(
      `DEPENDENCY_MAINTENANCE_TIMESTAMP_AFTER_SNAPSHOT name=${context.name} field=latestStable.publishedAt`,
    );
  }

  const observation = requireObject(
    registry['maintenanceObservation'],
    `DEPENDENCY_MAINTENANCE_OBSERVATION_MISSING name=${context.name}`,
  );
  requireString(
    observation['basis'],
    `DEPENDENCY_MAINTENANCE_OBSERVATION_BASIS_MISSING name=${context.name}`,
  );
  const recordedAgeDays = requireNonNegativeInteger(
    observation['ageDaysAtSnapshot'],
    `DEPENDENCY_MAINTENANCE_OBSERVATION_AGE_INVALID name=${context.name}`,
  );
  const recomputedAgeDays = elapsedWholeDays(context.snapshotAt, latestPublishedAt);
  if (recordedAgeDays !== recomputedAgeDays) {
    throw new Error(
      `DEPENDENCY_MAINTENANCE_OBSERVATION_AGE_INCONSISTENT name=${context.name} recorded=${String(recordedAgeDays)} recomputed=${String(recomputedAgeDays)}`,
    );
  }
  if (observation['status'] !== maintenanceWindow(recomputedAgeDays)) {
    throw new Error(`DEPENDENCY_MAINTENANCE_OBSERVATION_STATUS_INCONSISTENT name=${context.name}`);
  }

  const repository = requireObject(
    registry['repository'],
    `DEPENDENCY_MAINTENANCE_REPOSITORY_ENTRY_MISSING name=${context.name}`,
  );
  const registryValue = requireString(
    repository['registryValue'],
    `DEPENDENCY_MAINTENANCE_REPOSITORY_VALUE_MISSING name=${context.name}`,
  );
  if (repository['url'] !== normalizeRepositoryUrl(registryValue)) {
    throw new Error(`DEPENDENCY_MAINTENANCE_REPOSITORY_URL_INCONSISTENT name=${context.name}`);
  }
  requireNullableString(
    repository['directory'],
    `DEPENDENCY_MAINTENANCE_REPOSITORY_DIRECTORY_INVALID name=${context.name}`,
  );
}

/** @param {unknown} rawAdvisories @param {{name: string, snapshotAt: string, version: string}} context @returns {void} */
function validateAdvisoryEntry(rawAdvisories, context) {
  const advisories = requireObject(
    rawAdvisories,
    `DEPENDENCY_MAINTENANCE_ADVISORIES_MISSING name=${context.name}`,
  );
  requireNonNegativeInteger(
    advisories['pagesQueried'],
    `DEPENDENCY_MAINTENANCE_ADVISORY_PAGES_INVALID name=${context.name}`,
  );

  const query = requireObject(
    advisories['query'],
    `DEPENDENCY_MAINTENANCE_ADVISORY_QUERY_MISSING name=${context.name}`,
  );
  if (
    query['ecosystem'] !== 'npm' ||
    query['endpoint'] !== OSV_QUERY_URL ||
    query['name'] !== context.name ||
    query['version'] !== context.version
  ) {
    throw new Error(`DEPENDENCY_MAINTENANCE_ADVISORY_QUERY_MISMATCH name=${context.name}`);
  }

  const entries = requireArray(
    advisories['exactVersionAffectedAdvisories'],
    `DEPENDENCY_MAINTENANCE_ADVISORY_LIST_INVALID name=${context.name}`,
  );
  /** @type {string[]} */
  const identifiers = [];
  /** @type {string[]} */
  const unresolved = [];
  for (const candidate of entries) {
    const advisory = requireObject(
      candidate,
      `DEPENDENCY_MAINTENANCE_ADVISORY_ENTRY_INVALID name=${context.name}`,
    );
    const id = requireString(
      advisory['id'],
      `DEPENDENCY_MAINTENANCE_ADVISORY_ID_MISSING name=${context.name}`,
    );
    if (identifiers.includes(id)) {
      throw new Error(`DEPENDENCY_MAINTENANCE_ADVISORY_ID_DUPLICATE name=${context.name} id=${id}`);
    }
    requireBoolean(
      advisory['exactVersionAffected'],
      `DEPENDENCY_MAINTENANCE_ADVISORY_AFFECTED_INVALID name=${context.name} id=${id}`,
    );
    const modifiedAt = requireTimestamp(
      advisory['modifiedAt'],
      `DEPENDENCY_MAINTENANCE_ADVISORY_MODIFIED_INVALID name=${context.name} id=${id}`,
    );
    if (Date.parse(modifiedAt) > Date.parse(context.snapshotAt)) {
      throw new Error(
        `DEPENDENCY_MAINTENANCE_TIMESTAMP_AFTER_SNAPSHOT name=${context.name} field=advisory.modifiedAt id=${id}`,
      );
    }
    requireNullableTimestamp(
      advisory['publishedAt'],
      `DEPENDENCY_MAINTENANCE_ADVISORY_PUBLISHED_INVALID name=${context.name} id=${id}`,
    );
    const withdrawnAt = requireNullableTimestamp(
      advisory['withdrawnAt'],
      `DEPENDENCY_MAINTENANCE_ADVISORY_WITHDRAWN_INVALID name=${context.name} id=${id}`,
    );
    requireArray(
      advisory['aliases'],
      `DEPENDENCY_MAINTENANCE_ADVISORY_ALIASES_INVALID name=${context.name} id=${id}`,
    );
    identifiers.push(id);
    if (withdrawnAt === null) {
      unresolved.push(id);
    }
  }

  const sorted = [...identifiers].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(identifiers) !== JSON.stringify(sorted)) {
    throw new Error(`DEPENDENCY_MAINTENANCE_ADVISORY_ORDER_INVALID name=${context.name}`);
  }
  const returnedIds = requireArray(
    advisories['returnedIds'],
    `DEPENDENCY_MAINTENANCE_ADVISORY_IDS_INVALID name=${context.name}`,
  );
  if (JSON.stringify(returnedIds) !== JSON.stringify(identifiers)) {
    throw new Error(`DEPENDENCY_MAINTENANCE_ADVISORY_IDS_INCONSISTENT name=${context.name}`);
  }
  const knownAffected = requireBoolean(
    advisories['knownAffectedAtSnapshot'],
    `DEPENDENCY_MAINTENANCE_ADVISORY_FLAG_INVALID name=${context.name}`,
  );
  if (knownAffected !== identifiers.length > 0) {
    throw new Error(`DEPENDENCY_MAINTENANCE_ADVISORY_FLAG_INCONSISTENT name=${context.name}`);
  }

  // An advisory that affects the exact locked version and has not been withdrawn fails the gate.
  if (unresolved.length > 0) {
    throw new Error(
      `DEPENDENCY_MAINTENANCE_ADVISORY_UNRESOLVED name=${context.name} version=${context.version} ids=${unresolved.join(',')}`,
    );
  }
}

/** @param {Response} response @param {number} limitBytes @param {string} code @returns {Promise<unknown>} */
async function boundedJson(response, limitBytes, code) {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredBytes = Number.parseInt(contentLength, 10);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > limitBytes) {
      throw new Error(`${code}_SIZE declared=${contentLength} limit=${String(limitBytes)}`);
    }
  }
  if (response.body === null) {
    throw new Error(`${code}_BODY_MISSING`);
  }

  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let receivedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    receivedBytes += value.byteLength;
    if (receivedBytes > limitBytes) {
      await reader.cancel(`${code}_SIZE`);
      throw new Error(`${code}_SIZE received=${String(receivedBytes)} limit=${String(limitBytes)}`);
    }
    chunks.push(value);
  }

  const serialized = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  try {
    return JSON.parse(serialized);
  } catch (error) {
    throw new Error(`${code}_JSON_INVALID`, { cause: error });
  }
}

/**
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} limitBytes
 * @param {string} code
 * @returns {Promise<unknown>}
 */
async function fetchJson(url, options, limitBytes, code) {
  let response;
  try {
    response = await globalThis.fetch(url, {
      ...options,
      headers: {
        accept: 'application/json',
        'user-agent': 'hack-for-humanity-summer-2026-dependency-evidence/1',
        ...options.headers,
      },
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`${code}_NETWORK`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`${code}_HTTP status=${String(response.status)}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('json')) {
    throw new Error(`${code}_CONTENT_TYPE value=${contentType || 'missing'}`);
  }
  try {
    return await boundedJson(response, limitBytes, code);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${code}_`)) {
      throw error;
    }
    throw new Error(`${code}_BODY_READ`, { cause: error });
  }
}

/**
 * @param {JsonObject} versionMetadata
 * @param {string} dependencyName
 * @returns {{directory: string | null, registryValue: string, url: string}}
 */
function repositoryEvidence(versionMetadata, dependencyName) {
  const repository = versionMetadata['repository'];
  let registryValue;
  let directory = null;
  if (typeof repository === 'string') {
    registryValue = repository;
  } else {
    const repositoryObject = requireObject(
      repository,
      `DEPENDENCY_REPOSITORY_MISSING name=${dependencyName}`,
    );
    registryValue = requireString(
      repositoryObject['url'],
      `DEPENDENCY_REPOSITORY_URL_MISSING name=${dependencyName}`,
    );
    if (repositoryObject['directory'] !== undefined) {
      directory = requireString(
        repositoryObject['directory'],
        `DEPENDENCY_REPOSITORY_DIRECTORY_INVALID name=${dependencyName}`,
      );
    }
  }
  return {
    directory,
    registryValue,
    url: normalizeRepositoryUrl(registryValue),
  };
}

/** @param {DirectDependency} dependency @param {string} snapshotAt @returns {Promise<JsonObject>} */
async function registryEvidence(dependency, snapshotAt) {
  const endpoint = `${NPM_REGISTRY_ORIGIN}/${encodeURIComponent(dependency.name)}`;
  const packument = requireObject(
    await fetchJson(endpoint, { method: 'GET' }, REGISTRY_RESPONSE_LIMIT_BYTES, 'NPM_REGISTRY'),
    `NPM_REGISTRY_SCHEMA name=${dependency.name}`,
  );
  if (packument['name'] !== dependency.name) {
    throw new Error(`NPM_REGISTRY_NAME_MISMATCH name=${dependency.name}`);
  }

  const versions = requireObject(
    packument['versions'],
    `NPM_REGISTRY_VERSIONS_MISSING name=${dependency.name}`,
  );
  const exactMetadata = requireObject(
    versions[dependency.version],
    `NPM_REGISTRY_EXACT_VERSION_MISSING name=${dependency.name} version=${dependency.version}`,
  );
  const distTags = requireObject(
    packument['dist-tags'],
    `NPM_REGISTRY_DIST_TAGS_MISSING name=${dependency.name}`,
  );
  const latestStableVersion = requireString(
    distTags['latest'],
    `NPM_REGISTRY_LATEST_MISSING name=${dependency.name}`,
  );
  if (latestStableVersion.includes('-')) {
    throw new Error(
      `NPM_REGISTRY_LATEST_NOT_STABLE name=${dependency.name} version=${latestStableVersion}`,
    );
  }
  const latestMetadata = requireObject(
    versions[latestStableVersion],
    `NPM_REGISTRY_LATEST_VERSION_MISSING name=${dependency.name} version=${latestStableVersion}`,
  );
  const time = requireObject(
    packument['time'],
    `NPM_REGISTRY_TIME_MISSING name=${dependency.name}`,
  );
  const exactVersionPublishedAt = requireTimestamp(
    time[dependency.version],
    `NPM_REGISTRY_EXACT_TIME_MISSING name=${dependency.name} version=${dependency.version}`,
  );
  const latestStablePublishedAt = requireTimestamp(
    time[latestStableVersion],
    `NPM_REGISTRY_LATEST_TIME_MISSING name=${dependency.name} version=${latestStableVersion}`,
  );
  const registryModifiedAt = requireTimestamp(
    time['modified'],
    `NPM_REGISTRY_MODIFIED_TIME_MISSING name=${dependency.name}`,
  );
  const snapshotMilliseconds = Date.parse(snapshotAt);
  if (
    Date.parse(latestStablePublishedAt) > snapshotMilliseconds ||
    Date.parse(registryModifiedAt) > snapshotMilliseconds
  ) {
    throw new Error(
      `DEPENDENCY_SNAPSHOT_CLOCK_INVALID name=${dependency.name} snapshot=${snapshotAt} registryModified=${registryModifiedAt}`,
    );
  }
  const latestStableAgeDays = elapsedWholeDays(snapshotAt, latestStablePublishedAt);

  const exactDeprecation = exactMetadata['deprecated'];
  const latestDeprecation = latestMetadata['deprecated'];
  if (exactDeprecation !== undefined && typeof exactDeprecation !== 'string') {
    throw new Error(`NPM_REGISTRY_DEPRECATION_INVALID name=${dependency.name}`);
  }
  if (latestDeprecation !== undefined && typeof latestDeprecation !== 'string') {
    throw new Error(`NPM_REGISTRY_LATEST_DEPRECATION_INVALID name=${dependency.name}`);
  }

  return {
    deprecation: exactDeprecation ?? null,
    exactVersionPublishedAt,
    latestStable: {
      deprecation: latestDeprecation ?? null,
      publishedAt: latestStablePublishedAt,
      version: latestStableVersion,
    },
    maintenanceObservation: {
      ageDaysAtSnapshot: latestStableAgeDays,
      basis:
        'npm dist-tags.latest publish age at snapshot; bounded observation, not a maintainer claim',
      status: maintenanceWindow(latestStableAgeDays),
    },
    registryEndpoint: endpoint,
    registryModifiedAt,
    repository: repositoryEvidence(exactMetadata, dependency.name),
  };
}

/** @param {unknown} value @param {string} code @returns {string[]} */
function optionalStringArray(value, code) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(code);
  }
  return [...new Set(value)].sort();
}

/** @param {DirectDependency} dependency @param {string} snapshotAt @returns {Promise<JsonObject>} */
async function advisoryEvidence(dependency, snapshotAt) {
  /** @type {Map<string, JsonObject>} */
  const vulnerabilities = new Map();
  let pageToken;
  let pagesQueried = 0;

  do {
    pagesQueried += 1;
    if (pagesQueried > MAX_OSV_PAGES) {
      throw new Error(`OSV_PAGE_LIMIT name=${dependency.name} limit=${String(MAX_OSV_PAGES)}`);
    }
    const requestBody = {
      package: { ecosystem: 'npm', name: dependency.name },
      ...(pageToken === undefined ? {} : { page_token: pageToken }),
      version: dependency.version,
    };
    const response = requireObject(
      await fetchJson(
        OSV_QUERY_URL,
        {
          body: JSON.stringify(requestBody),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        },
        OSV_RESPONSE_LIMIT_BYTES,
        'OSV_QUERY',
      ),
      `OSV_SCHEMA name=${dependency.name}`,
    );
    const returned = response['vulns'] ?? [];
    if (!Array.isArray(returned)) {
      throw new Error(`OSV_VULNERABILITIES_INVALID name=${dependency.name}`);
    }
    for (const candidate of returned) {
      const vulnerability = requireObject(candidate, `OSV_ENTRY_INVALID name=${dependency.name}`);
      const id = requireString(vulnerability['id'], `OSV_ID_MISSING name=${dependency.name}`);
      if (vulnerabilities.has(id)) {
        throw new Error(`OSV_ID_DUPLICATE name=${dependency.name} id=${id}`);
      }
      const modifiedAt = requireTimestamp(
        vulnerability['modified'],
        `OSV_MODIFIED_MISSING name=${dependency.name} id=${id}`,
      );
      if (Date.parse(modifiedAt) > Date.parse(snapshotAt)) {
        throw new Error(
          `DEPENDENCY_SNAPSHOT_CLOCK_INVALID name=${dependency.name} snapshot=${snapshotAt} osvModified=${modifiedAt}`,
        );
      }
      const publishedAt =
        vulnerability['published'] === undefined
          ? null
          : requireTimestamp(
              vulnerability['published'],
              `OSV_PUBLISHED_INVALID name=${dependency.name} id=${id}`,
            );
      const withdrawnAt =
        vulnerability['withdrawn'] === undefined
          ? null
          : requireTimestamp(
              vulnerability['withdrawn'],
              `OSV_WITHDRAWN_INVALID name=${dependency.name} id=${id}`,
            );
      vulnerabilities.set(id, {
        aliases: optionalStringArray(
          vulnerability['aliases'],
          `OSV_ALIASES_INVALID name=${dependency.name} id=${id}`,
        ),
        exactVersionAffected: true,
        id,
        modifiedAt,
        publishedAt,
        withdrawnAt,
      });
    }

    const nextPageToken = response['next_page_token'];
    if (nextPageToken === undefined || nextPageToken === '') {
      pageToken = undefined;
    } else {
      pageToken = requireString(nextPageToken, `OSV_PAGE_TOKEN_INVALID name=${dependency.name}`);
    }
  } while (pageToken !== undefined);

  const entries = [...vulnerabilities.values()].sort((left, right) =>
    String(left['id']).localeCompare(String(right['id'])),
  );
  return {
    exactVersionAffectedAdvisories: entries,
    knownAffectedAtSnapshot: entries.length > 0,
    pagesQueried,
    query: {
      ecosystem: 'npm',
      endpoint: OSV_QUERY_URL,
      name: dependency.name,
      version: dependency.version,
    },
    returnedIds: entries.map((entry) => entry['id']),
  };
}

/**
 * @param {DirectDependency[]} directDependencies
 * @param {string} repository
 * @param {string} snapshotAt
 * @returns {Promise<unknown>}
 */
async function refreshEvidence(directDependencies, repository, snapshotAt) {
  /** @type {JsonObject[]} */
  const dependencies = [];
  for (let offset = 0; offset < directDependencies.length; offset += REGISTRY_CONCURRENCY) {
    const chunk = directDependencies.slice(offset, offset + REGISTRY_CONCURRENCY);
    const registryResults = await Promise.all(
      chunk.map((dependency) => registryEvidence(dependency, snapshotAt)),
    );
    const advisoryResults = await Promise.all(
      chunk.map((dependency) => advisoryEvidence(dependency, snapshotAt)),
    );
    for (const [index, dependency] of chunk.entries()) {
      const registry = registryResults[index];
      const advisories = advisoryResults[index];
      if (registry === undefined || advisories === undefined) {
        throw new Error(`DEPENDENCY_MAINTENANCE_RESULT_MISSING name=${dependency.name}`);
      }
      dependencies.push({
        advisories,
        name: dependency.name,
        registry,
        version: dependency.version,
      });
    }
  }

  return normalizeEvidence({
    command: EVIDENCE_COMMAND,
    dependencies,
    directDependencyCount: directDependencies.length,
    maintenanceStatusPolicy: {
      basis: 'elapsed whole days between snapshotAt and npm dist-tags.latest publish timestamp',
      buckets: MAINTENANCE_BUCKETS,
      limitation:
        'A release-age bucket is not evidence of maintainer responsiveness or code safety.',
    },
    repository,
    schemaVersion: SCHEMA_VERSION,
    securityHistoryScope:
      'Point-in-time exact-version OSV query results only; an empty result is not proof that no unknown or previously unrecorded vulnerability exists.',
    snapshotAt,
    sources: {
      npmRegistry: `${NPM_REGISTRY_ORIGIN}/<encoded-package-name>`,
      npmRegistryDocumentation:
        'https://github.com/npm/registry/blob/master/docs/responses/package-metadata.md',
      osvQuery: OSV_QUERY_URL,
      osvQueryDocumentation: 'https://google.github.io/osv.dev/post-v1-query/',
    },
  });
}

/** @returns {Promise<void>} */
async function main() {
  const outputPath = resolve(REPOSITORY_ROOT, 'evidence', 'tier-0', 'dependency-maintenance.json');
  const manifest = /** @type {{devDependencies?: Record<string, string>, name?: string}} */ (
    JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, 'package.json'), 'utf8'))
  );
  const repository = requireString(manifest.name, 'DEPENDENCY_MAINTENANCE_REPOSITORY_MISSING');
  const directDependencies = directDependenciesOf(manifest);

  if (process.argv.includes('--check')) {
    if (!existsSync(outputPath)) {
      throw new Error(`DEPENDENCY_MAINTENANCE_EVIDENCE_MISSING run="${EVIDENCE_COMMAND}"`);
    }
    const serializedText = readFileSync(outputPath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(serializedText);
    } catch (error) {
      throw new Error('DEPENDENCY_MAINTENANCE_EVIDENCE_JSON_INVALID', { cause: error });
    }
    const summary = validateMaintenanceEvidence(parsed, serializedText, {
      directDependencies,
      nowMilliseconds: Date.now(),
      repository,
    });
    console.log(
      `dependency-maintenance current direct=${String(summary.directDependencyCount)} snapshot=${summary.snapshotAt} ageDays=${String(summary.snapshotAgeDays)} limitDays=${String(MAX_SNAPSHOT_AGE_DAYS)} source=committed-snapshot`,
    );
    return;
  }

  const snapshotAt = new Date().toISOString();
  const evidence = await refreshEvidence(directDependencies, repository, snapshotAt);
  const serialized = serializeEvidence(evidence);
  validateMaintenanceEvidence(evidence, serialized, {
    directDependencies,
    nowMilliseconds: Date.now(),
    repository,
  });
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized, 'utf8');
  console.log(
    `dependency-maintenance generated path=evidence/tier-0/dependency-maintenance.json direct=${String(directDependencies.length)} snapshot=${snapshotAt}`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
