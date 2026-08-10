import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { REPOSITORY_ROOT } from './npm-environment.mjs';

const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org';
const OSV_QUERY_URL = 'https://api.osv.dev/v1/query';
const NETWORK_TIMEOUT_MS = 30_000;
const REGISTRY_RESPONSE_LIMIT_BYTES = 64 * 1024 * 1024;
const OSV_RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;
const MAX_OSV_PAGES = 20;
const REGISTRY_CONCURRENCY = 3;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
const outputPath = resolve(REPOSITORY_ROOT, 'evidence', 'tier-0', 'dependency-maintenance.json');

/** @typedef {Record<string, unknown>} JsonObject */
/**
 * @typedef DirectDependency
 * @property {string} name
 * @property {string} version
 */

/** @param {unknown} value @param {string} code @returns {JsonObject} */
function requireObject(value, code) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(code);
  }
  return /** @type {JsonObject} */ (value);
}

/** @param {unknown} value @param {string} code @returns {string} */
function requireString(value, code) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(code);
  }
  return value;
}

/** @param {unknown} value @param {string} code @returns {string} */
function requireTimestamp(value, code) {
  const timestamp = requireString(value, code);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(code);
  }
  return timestamp;
}

const checkMode = process.argv.includes('--check');
const snapshotAt = (() => {
  if (!checkMode) {
    return new Date().toISOString();
  }
  if (!existsSync(outputPath)) {
    throw new Error('DEPENDENCY_MAINTENANCE_EVIDENCE_MISSING');
  }
  let existingValue;
  try {
    existingValue = JSON.parse(readFileSync(outputPath, 'utf8'));
  } catch (error) {
    throw new Error('DEPENDENCY_MAINTENANCE_EVIDENCE_JSON_INVALID', { cause: error });
  }
  const existing = requireObject(existingValue, 'DEPENDENCY_MAINTENANCE_EVIDENCE_INVALID');
  return requireTimestamp(
    existing['snapshotAt'],
    'DEPENDENCY_MAINTENANCE_SNAPSHOT_TIMESTAMP_INVALID',
  );
})();

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

/** @param {string} rawUrl @returns {string} */
function normalizeRepositoryUrl(rawUrl) {
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

/** @param {number} ageDays @returns {string} */
function maintenanceWindow(ageDays) {
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

/** @param {DirectDependency} dependency @returns {Promise<JsonObject>} */
async function registryEvidence(dependency) {
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
  const latestMilliseconds = Date.parse(latestStablePublishedAt);
  const registryModifiedMilliseconds = Date.parse(registryModifiedAt);
  if (
    !checkMode &&
    (latestMilliseconds > snapshotMilliseconds ||
      registryModifiedMilliseconds > snapshotMilliseconds)
  ) {
    throw new Error(
      `DEPENDENCY_SNAPSHOT_CLOCK_INVALID name=${dependency.name} snapshot=${snapshotAt} registryModified=${registryModifiedAt}`,
    );
  }
  const latestStableAgeDays = Math.max(
    0,
    Math.floor((snapshotMilliseconds - latestMilliseconds) / MILLISECONDS_PER_DAY),
  );

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

/** @param {DirectDependency} dependency @returns {Promise<JsonObject>} */
async function advisoryEvidence(dependency) {
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
      if (!checkMode && Date.parse(modifiedAt) > Date.parse(snapshotAt)) {
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

/** @param {unknown} value @returns {unknown} */
function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJson(entry));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(/** @type {JsonObject} */ (value))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

const manifest = /** @type {{devDependencies?: Record<string, string>, name?: string}} */ (
  JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, 'package.json'), 'utf8'))
);
const directDependencies = Object.entries(manifest.devDependencies ?? {})
  .map(([name, version]) => ({ name, version }))
  .sort((left, right) => left.name.localeCompare(right.name));
if (directDependencies.length === 0) {
  throw new Error('DEPENDENCY_MAINTENANCE_DIRECT_SET_EMPTY');
}

/** @type {JsonObject[]} */
const dependencies = [];
for (let offset = 0; offset < directDependencies.length; offset += REGISTRY_CONCURRENCY) {
  const chunk = directDependencies.slice(offset, offset + REGISTRY_CONCURRENCY);
  const registryResults = await Promise.all(
    chunk.map((dependency) => registryEvidence(dependency)),
  );
  const advisoryResults = await Promise.all(
    chunk.map((dependency) => advisoryEvidence(dependency)),
  );
  for (const [index, dependency] of chunk.entries()) {
    const registry = registryResults[index];
    const advisories = advisoryResults[index];
    if (registry === undefined || advisories === undefined) {
      throw new Error(`DEPENDENCY_MAINTENANCE_RESULT_MISSING name=${dependency.name}`);
    }
    dependencies.push({ advisories, name: dependency.name, registry, version: dependency.version });
  }
}

const evidence = sortJson({
  command: 'npm run evidence:dependency-maintenance',
  dependencies,
  directDependencyCount: directDependencies.length,
  maintenanceStatusPolicy: {
    basis: 'elapsed whole days between snapshotAt and npm dist-tags.latest publish timestamp',
    buckets: [
      'latest-stable-published-within-90-days',
      'latest-stable-published-within-180-days',
      'latest-stable-published-within-365-days',
      'no-stable-release-published-within-365-days',
    ],
    limitation: 'A release-age bucket is not evidence of maintainer responsiveness or code safety.',
  },
  repository: requireString(manifest.name, 'DEPENDENCY_MAINTENANCE_REPOSITORY_MISSING'),
  schemaVersion: 1,
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
const serialized = `${JSON.stringify(evidence, null, 2)}\n`;

if (checkMode) {
  if (!existsSync(outputPath) || readFileSync(outputPath, 'utf8') !== serialized) {
    throw new Error(
      'DEPENDENCY_MAINTENANCE_EVIDENCE_STALE run="npm run evidence:dependency-maintenance"',
    );
  }
  console.log(`dependency-maintenance current direct=${String(directDependencies.length)}`);
} else {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized, 'utf8');
  console.log(
    `dependency-maintenance generated path=evidence/tier-0/dependency-maintenance.json direct=${String(directDependencies.length)}`,
  );
}
