import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withRepositoryNpmCache } from './npm-environment.mjs';

const EVIDENCE_COMMAND = 'npm run evidence:sbom';
const LOCK_SOURCE = 'package-lock.json';
const PROVENANCE_COMMAND = 'npm sbom --package-lock-only --sbom-format cyclonedx';
const EVIDENCE_SEED = 'not-applicable-deterministic-lock-graph';
const REPOSITORY_PROPERTY_PREFIX = 'repository:';
const REQUIRED_CROSS_PLATFORM_COMPONENTS = [
  '@esbuild/darwin-arm64',
  '@esbuild/darwin-x64',
  '@esbuild/linux-arm64',
  '@esbuild/linux-x64',
  '@rollup/rollup-darwin-arm64',
  '@rollup/rollup-darwin-x64',
  '@rollup/rollup-linux-arm64-gnu',
  '@rollup/rollup-linux-x64-gnu',
];

/** @param {string} left @param {string} right @returns {number} */
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** @typedef {Record<string, unknown>} JsonObject */
/**
 * @typedef LockedPackage
 * @property {string[]} cpu
 * @property {boolean} development
 * @property {string} identity
 * @property {string} integrity
 * @property {string[]} libc
 * @property {string} license
 * @property {string} name
 * @property {boolean} optional
 * @property {string[]} os
 * @property {string} path
 * @property {string} version
 */

/** @param {unknown} value @returns {value is JsonObject} */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} code @returns {JsonObject} */
function requireObject(value, code) {
  if (!isObject(value)) {
    throw new Error(code);
  }
  return value;
}

/** @param {unknown} value @param {string} code @returns {unknown[]} */
function requireArray(value, code) {
  if (!Array.isArray(value)) {
    throw new Error(code);
  }
  return value;
}

/** @param {unknown} value @param {string} code @returns {string} */
function requireString(value, code) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(code);
  }
  return value;
}

/** @param {unknown} value @returns {string[]} */
function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((candidate) => typeof candidate === 'string').sort()
    : [];
}

/** @param {string} path @param {JsonObject} entry @returns {string} */
function lockedPackageName(path, entry) {
  if (typeof entry['name'] === 'string' && entry['name'].length > 0) {
    return entry['name'];
  }
  const marker = 'node_modules/';
  const markerIndex = path.lastIndexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`SBOM_LOCK_PACKAGE_NAME_MISSING path=${path}`);
  }
  const pathAfterNodeModules = path.slice(markerIndex + marker.length);
  const segments = pathAfterNodeModules.split('/');
  const name = pathAfterNodeModules.startsWith('@')
    ? segments.slice(0, 2).join('/')
    : (segments[0] ?? '');
  if (name.length === 0 || (name.startsWith('@') && !name.includes('/'))) {
    throw new Error(`SBOM_LOCK_PACKAGE_NAME_INVALID path=${path}`);
  }
  return name;
}

/** @param {string} name @param {string} version @returns {string} */
function packagePurl(name, version) {
  const encodedName = name.startsWith('@')
    ? name
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/')
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

/** @param {JsonObject} lock @returns {LockedPackage[]} */
export function lockedPackages(lock) {
  const packages = requireObject(lock['packages'], 'SBOM_LOCK_PACKAGES_MISSING');
  return Object.entries(packages)
    .filter(([path]) => path !== '')
    .map(([path, rawEntry]) => {
      const entry = requireObject(rawEntry, `SBOM_LOCK_ENTRY_INVALID path=${path}`);
      const name = lockedPackageName(path, entry);
      const version = requireString(
        entry['version'],
        `SBOM_LOCK_PACKAGE_VERSION_MISSING path=${path}`,
      );
      return {
        cpu: stringArray(entry['cpu']),
        development: entry['dev'] === true,
        identity: `${name}@${version}`,
        integrity: requireString(
          entry['integrity'],
          `SBOM_LOCK_PACKAGE_INTEGRITY_MISSING path=${path}`,
        ),
        libc: stringArray(entry['libc']),
        license: requireString(entry['license'], `SBOM_LOCK_PACKAGE_LICENSE_MISSING path=${path}`),
        name,
        optional: entry['optional'] === true,
        os: stringArray(entry['os']),
        path,
        version,
      };
    })
    .sort((left, right) => compareText(left.path, right.path));
}

/** @param {LockedPackage[]} entries @returns {Map<string, LockedPackage[]>} */
function groupLockedPackages(entries) {
  /** @type {Map<string, LockedPackage[]>} */
  const groups = new Map();
  for (const entry of entries) {
    const group = groups.get(entry.identity) ?? [];
    group.push(entry);
    groups.set(entry.identity, group);
  }
  return groups;
}

/** @param {unknown} value @returns {unknown} */
function canonicalizeObjectKeys(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeObjectKeys(entry));
  }
  if (!isObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => [key, canonicalizeObjectKeys(entry)]),
  );
}

/** @param {unknown[]} values @returns {unknown[]} */
function sortByCanonicalJson(values) {
  return values
    .map((value) => canonicalizeObjectKeys(value))
    .sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right)));
}

/** @param {JsonObject} component @param {LockedPackage[]} entries @returns {void} */
function addLockfileProvenance(component, entries) {
  const existingProperties = Array.isArray(component['properties'])
    ? component['properties'].filter((property) => {
        if (!isObject(property) || typeof property['name'] !== 'string') {
          return true;
        }
        return !property['name'].startsWith(`${REPOSITORY_PROPERTY_PREFIX}lockfile-`);
      })
    : [];
  const operatingSystems = [...new Set(entries.flatMap((entry) => entry.os))].sort();
  const cpuArchitectures = [...new Set(entries.flatMap((entry) => entry.cpu))].sort();
  const libcVariants = [...new Set(entries.flatMap((entry) => entry.libc))].sort();
  const properties = [
    ...existingProperties,
    {
      name: 'repository:lockfile-paths',
      value: JSON.stringify(entries.map((entry) => entry.path).sort()),
    },
    {
      name: 'repository:lockfile-optional',
      value: String(entries.every((entry) => entry.optional)),
    },
  ];
  if (operatingSystems.length > 0) {
    properties.push({
      name: 'repository:lockfile-os',
      value: operatingSystems.join(','),
    });
  }
  if (cpuArchitectures.length > 0) {
    properties.push({
      name: 'repository:lockfile-cpu',
      value: cpuArchitectures.join(','),
    });
  }
  if (libcVariants.length > 0) {
    properties.push({
      name: 'repository:lockfile-libc',
      value: libcVariants.join(','),
    });
  }
  component['properties'] = sortByCanonicalJson(properties);
}

/**
 * @param {JsonObject} rawBillOfMaterials
 * @param {JsonObject} lock
 * @param {string} lockfileText
 * @returns {JsonObject}
 */
export function normalizeBillOfMaterials(rawBillOfMaterials, lock, lockfileText) {
  const billOfMaterials = requireObject(
    JSON.parse(JSON.stringify(rawBillOfMaterials)),
    'SBOM_OUTPUT_INVALID',
  );
  delete billOfMaterials['serialNumber'];
  const metadata = requireObject(billOfMaterials['metadata'], 'SBOM_METADATA_MISSING');
  delete metadata['timestamp'];

  const lockEntries = lockedPackages(lock);
  const groups = groupLockedPackages(lockEntries);
  const components = requireArray(billOfMaterials['components'], 'SBOM_COMPONENTS_MISSING').map(
    (rawComponent) => {
      const component = requireObject(rawComponent, 'SBOM_COMPONENT_INVALID');
      const identity = requireString(component['bom-ref'], 'SBOM_COMPONENT_REF_MISSING');
      const entries = groups.get(identity);
      if (entries === undefined) {
        throw new Error(`SBOM_COMPONENT_NOT_LOCKED ref=${identity}`);
      }
      addLockfileProvenance(component, entries);
      return component;
    },
  );
  components.sort((left, right) => compareText(String(left['bom-ref']), String(right['bom-ref'])));
  billOfMaterials['components'] = components;

  const rootPackage = requireObject(
    requireObject(lock['packages'], 'SBOM_LOCK_PACKAGES_MISSING')[''],
    'SBOM_LOCK_ROOT_MISSING',
  );
  const rootName = requireString(rootPackage['name'], 'SBOM_LOCK_ROOT_NAME_MISSING');
  const rootVersion = requireString(rootPackage['version'], 'SBOM_LOCK_ROOT_VERSION_MISSING');
  const rootComponent = requireObject(metadata['component'], 'SBOM_ROOT_COMPONENT_MISSING');
  rootComponent['bom-ref'] = `${rootName}@${rootVersion}`;
  rootComponent['name'] = rootName;
  rootComponent['purl'] = packagePurl(rootName, rootVersion);
  rootComponent['type'] = 'application';
  rootComponent['version'] = rootVersion;
  if (Array.isArray(rootComponent['properties'])) {
    rootComponent['properties'] = sortByCanonicalJson(rootComponent['properties']);
  }

  const existingMetadataProperties = Array.isArray(metadata['properties'])
    ? metadata['properties'].filter((property) => {
        if (!isObject(property) || typeof property['name'] !== 'string') {
          return true;
        }
        return !property['name'].startsWith(REPOSITORY_PROPERTY_PREFIX);
      })
    : [];
  metadata['properties'] = sortByCanonicalJson([
    ...existingMetadataProperties,
    { name: 'repository:evidence-command', value: EVIDENCE_COMMAND },
    { name: 'repository:evidence-seed', value: EVIDENCE_SEED },
    { name: 'repository:locked-component-identity-count', value: String(groups.size) },
    { name: 'repository:locked-package-entry-count', value: String(lockEntries.length) },
    { name: 'repository:provenance-command', value: PROVENANCE_COMMAND },
    { name: 'repository:source', value: LOCK_SOURCE },
    {
      name: 'repository:source-lockfile-version',
      value: String(lock['lockfileVersion'] ?? 'unknown'),
    },
    {
      name: 'repository:source-name',
      value: rootName,
    },
    {
      name: 'repository:source-sha256',
      value: createHash('sha256').update(lockfileText).digest('hex'),
    },
  ]);

  const dependencies = requireArray(
    billOfMaterials['dependencies'],
    'SBOM_DEPENDENCIES_MISSING',
  ).map((rawDependency) => {
    const dependency = requireObject(rawDependency, 'SBOM_DEPENDENCY_INVALID');
    dependency['dependsOn'] = stringArray(dependency['dependsOn']);
    return dependency;
  });
  dependencies.sort((left, right) => compareText(String(left['ref']), String(right['ref'])));
  billOfMaterials['dependencies'] = dependencies;

  return /** @type {JsonObject} */ (canonicalizeObjectKeys(billOfMaterials));
}

/** @param {JsonObject} component @param {string} name @returns {string | undefined} */
function componentProperty(component, name) {
  const properties = Array.isArray(component['properties']) ? component['properties'] : [];
  for (const property of properties) {
    if (isObject(property) && property['name'] === name && typeof property['value'] === 'string') {
      return property['value'];
    }
  }
  return undefined;
}

/** @param {LockedPackage} entry @returns {{algorithm: string, content: string}} */
function integrityHash(entry) {
  const separatorIndex = entry.integrity.indexOf('-');
  if (separatorIndex <= 0) {
    throw new Error(`SBOM_LOCK_INTEGRITY_INVALID path=${entry.path}`);
  }
  const algorithm = entry.integrity.slice(0, separatorIndex).toUpperCase().replace('SHA', 'SHA-');
  const encodedContent = entry.integrity.slice(separatorIndex + 1);
  return {
    algorithm,
    content: Buffer.from(encodedContent, 'base64').toString('hex'),
  };
}

/** @param {JsonObject} component @param {LockedPackage} entry @returns {void} */
function validateComponentMaterial(component, entry) {
  if (component['name'] !== entry.name || component['version'] !== entry.version) {
    throw new Error(`SBOM_COMPONENT_IDENTITY_MISMATCH ref=${entry.identity}`);
  }
  if (component['purl'] !== packagePurl(entry.name, entry.version)) {
    throw new Error(`SBOM_COMPONENT_PURL_INVALID ref=${entry.identity}`);
  }
  const expectedHash = integrityHash(entry);
  const hashes = Array.isArray(component['hashes']) ? component['hashes'] : [];
  if (
    !hashes.some(
      (hash) =>
        isObject(hash) &&
        hash['alg'] === expectedHash.algorithm &&
        hash['content'] === expectedHash.content,
    )
  ) {
    throw new Error(`SBOM_COMPONENT_INTEGRITY_MISMATCH ref=${entry.identity}`);
  }
  const licenses = Array.isArray(component['licenses']) ? component['licenses'] : [];
  if (
    !licenses.some((licenseChoice) => {
      if (!isObject(licenseChoice)) {
        return false;
      }
      if (licenseChoice['expression'] === entry.license) {
        return true;
      }
      if (!isObject(licenseChoice['license'])) {
        return false;
      }
      return licenseChoice['license']['id'] === entry.license;
    })
  ) {
    throw new Error(`SBOM_COMPONENT_LICENSE_MISMATCH ref=${entry.identity}`);
  }
}

/**
 * @param {JsonObject} billOfMaterials
 * @param {JsonObject} lock
 * @param {string} lockfileText
 * @param {string} repositoryRoot
 * @returns {void}
 */
export function validateBillOfMaterials(billOfMaterials, lock, lockfileText, repositoryRoot) {
  if (
    billOfMaterials['bomFormat'] !== 'CycloneDX' ||
    typeof billOfMaterials['specVersion'] !== 'string'
  ) {
    throw new Error('SBOM_FORMAT_INVALID');
  }
  if ('serialNumber' in billOfMaterials) {
    throw new Error('SBOM_NONDETERMINISTIC_SERIAL_NUMBER');
  }
  const metadata = requireObject(billOfMaterials['metadata'], 'SBOM_METADATA_MISSING');
  if ('timestamp' in metadata) {
    throw new Error('SBOM_NONDETERMINISTIC_TIMESTAMP');
  }
  const rootComponent = requireObject(metadata['component'], 'SBOM_ROOT_COMPONENT_MISSING');
  const rootPackage = requireObject(
    requireObject(lock['packages'], 'SBOM_LOCK_PACKAGES_MISSING')[''],
    'SBOM_LOCK_ROOT_MISSING',
  );
  const rootName = requireString(rootPackage['name'], 'SBOM_LOCK_ROOT_NAME_MISSING');
  const rootVersion = requireString(rootPackage['version'], 'SBOM_LOCK_ROOT_VERSION_MISSING');
  const rootRef = `${rootName}@${rootVersion}`;
  if (
    rootComponent['bom-ref'] !== rootRef ||
    rootComponent['name'] !== rootName ||
    rootComponent['version'] !== rootVersion ||
    rootComponent['type'] !== 'application' ||
    rootComponent['purl'] !== packagePurl(rootName, rootVersion)
  ) {
    throw new Error('SBOM_ROOT_COMPONENT_INVALID');
  }

  const lockEntries = lockedPackages(lock);
  const groups = groupLockedPackages(lockEntries);
  const components = requireArray(billOfMaterials['components'], 'SBOM_COMPONENTS_MISSING').map(
    (component) => requireObject(component, 'SBOM_COMPONENT_INVALID'),
  );
  if (components.length !== groups.size) {
    throw new Error(
      `SBOM_COMPONENT_COUNT_MISMATCH expected=${String(groups.size)} actual=${String(components.length)}`,
    );
  }
  const componentMap = new Map(
    components.map((component) => [
      requireString(component['bom-ref'], 'SBOM_COMPONENT_REF_MISSING'),
      component,
    ]),
  );
  if (componentMap.size !== components.length) {
    throw new Error('SBOM_COMPONENT_REF_DUPLICATE');
  }
  const sortedComponentRefs = [...componentMap.keys()].sort();
  if (
    JSON.stringify(components.map((component) => component['bom-ref'])) !==
    JSON.stringify(sortedComponentRefs)
  ) {
    throw new Error('SBOM_COMPONENTS_NOT_SORTED');
  }

  for (const [identity, entries] of groups) {
    const component = componentMap.get(identity);
    if (component === undefined) {
      throw new Error(`SBOM_LOCK_ENTRY_UNREPRESENTED ref=${identity}`);
    }
    for (const entry of entries) {
      validateComponentMaterial(component, entry);
    }
    const expectedPaths = JSON.stringify(entries.map((entry) => entry.path).sort());
    if (componentProperty(component, 'repository:lockfile-paths') !== expectedPaths) {
      throw new Error(`SBOM_LOCK_PATH_PROVENANCE_INVALID ref=${identity}`);
    }
    const allOptional = entries.every((entry) => entry.optional);
    const excludedFromProduction = entries.every((entry) => entry.optional || entry.development);
    if (
      component['scope'] !== (excludedFromProduction ? 'optional' : 'required') ||
      componentProperty(component, 'repository:lockfile-optional') !== String(allOptional)
    ) {
      throw new Error(`SBOM_COMPONENT_SCOPE_INVALID ref=${identity}`);
    }
  }

  for (const name of REQUIRED_CROSS_PLATFORM_COMPONENTS) {
    const matchingEntries = lockEntries.filter((entry) => entry.name === name);
    if (matchingEntries.length === 0) {
      throw new Error(`SBOM_REQUIRED_PLATFORM_LOCK_ENTRY_MISSING name=${name}`);
    }
    for (const entry of matchingEntries) {
      if (!componentMap.has(entry.identity)) {
        throw new Error(`SBOM_REQUIRED_PLATFORM_COMPONENT_MISSING name=${name}`);
      }
    }
  }

  const dependencies = requireArray(
    billOfMaterials['dependencies'],
    'SBOM_DEPENDENCIES_MISSING',
  ).map((dependency) => requireObject(dependency, 'SBOM_DEPENDENCY_INVALID'));
  const allComponentRefs = new Set([rootRef, ...componentMap.keys()]);
  if (dependencies.length !== allComponentRefs.size) {
    throw new Error('SBOM_DEPENDENCY_RECORD_COUNT_INVALID');
  }
  const dependencyRefs = dependencies.map((dependency) =>
    requireString(dependency['ref'], 'SBOM_DEPENDENCY_REF_MISSING'),
  );
  if (
    new Set(dependencyRefs).size !== dependencyRefs.length ||
    dependencyRefs.some((dependencyRef) => !allComponentRefs.has(dependencyRef))
  ) {
    throw new Error('SBOM_DEPENDENCY_REF_INVALID');
  }
  if (JSON.stringify(dependencyRefs) !== JSON.stringify([...dependencyRefs].sort())) {
    throw new Error('SBOM_DEPENDENCIES_NOT_SORTED');
  }
  for (const dependency of dependencies) {
    const dependsOn = requireArray(
      dependency['dependsOn'],
      `SBOM_DEPENDS_ON_INVALID ref=${String(dependency['ref'])}`,
    );
    if (
      dependsOn.some((target) => typeof target !== 'string' || !allComponentRefs.has(target)) ||
      new Set(dependsOn).size !== dependsOn.length ||
      JSON.stringify(dependsOn) !== JSON.stringify([...dependsOn].sort())
    ) {
      throw new Error(`SBOM_DEPENDENCY_EDGE_INVALID ref=${String(dependency['ref'])}`);
    }
  }

  const rootDependency = dependencies.find((dependency) => dependency['ref'] === rootRef);
  if (rootDependency === undefined) {
    throw new Error('SBOM_ROOT_DEPENDENCY_MISSING');
  }
  const directNames = new Set([
    ...Object.keys(isObject(rootPackage['dependencies']) ? rootPackage['dependencies'] : {}),
    ...Object.keys(isObject(rootPackage['devDependencies']) ? rootPackage['devDependencies'] : {}),
    ...Object.keys(
      isObject(rootPackage['optionalDependencies']) ? rootPackage['optionalDependencies'] : {},
    ),
  ]);
  const expectedDirectRefs = [...directNames]
    .map((name) => {
      const entry = requireObject(
        requireObject(lock['packages'], 'SBOM_LOCK_PACKAGES_MISSING')[`node_modules/${name}`],
        `SBOM_DIRECT_LOCK_ENTRY_MISSING name=${name}`,
      );
      return `${name}@${requireString(entry['version'], `SBOM_DIRECT_VERSION_MISSING name=${name}`)}`;
    })
    .sort();
  if (JSON.stringify(rootDependency['dependsOn']) !== JSON.stringify(expectedDirectRefs)) {
    throw new Error('SBOM_ROOT_DEPENDENCY_EDGES_INVALID');
  }

  const metadataProperties = Array.isArray(metadata['properties']) ? metadata['properties'] : [];
  const metadataPropertyMap = new Map(
    metadataProperties
      .filter(
        (property) =>
          isObject(property) &&
          typeof property['name'] === 'string' &&
          typeof property['value'] === 'string',
      )
      .map((property) => {
        const typedProperty = /** @type {JsonObject} */ (property);
        return [String(typedProperty['name']), String(typedProperty['value'])];
      }),
  );
  const expectedMetadataProperties = new Map([
    ['repository:evidence-command', EVIDENCE_COMMAND],
    ['repository:evidence-seed', EVIDENCE_SEED],
    ['repository:locked-component-identity-count', String(groups.size)],
    ['repository:locked-package-entry-count', String(lockEntries.length)],
    ['repository:provenance-command', PROVENANCE_COMMAND],
    ['repository:source', LOCK_SOURCE],
    ['repository:source-lockfile-version', String(lock['lockfileVersion'] ?? 'unknown')],
    ['repository:source-name', rootName],
    ['repository:source-sha256', createHash('sha256').update(lockfileText).digest('hex')],
  ]);
  for (const [name, value] of expectedMetadataProperties) {
    if (metadataPropertyMap.get(name) !== value) {
      throw new Error(`SBOM_METADATA_PROVENANCE_INVALID name=${name}`);
    }
  }

  const serialized = serializeBillOfMaterials(billOfMaterials);
  if (
    serialized.includes(repositoryRoot) ||
    /(?:file:\/\/\/|\/Users\/|[A-Za-z]:\\Users\\)/u.test(serialized)
  ) {
    throw new Error('SBOM_HOST_PATH_LEAK');
  }
}

/** @param {JsonObject} billOfMaterials @returns {string} */
export function serializeBillOfMaterials(billOfMaterials) {
  return `${JSON.stringify(billOfMaterials, null, 2)}\n`;
}

/** @returns {void} */
function main() {
  const repositoryRoot = resolve(import.meta.dirname, '..');
  const outputPath = resolve(repositoryRoot, 'evidence', 'tier-0', 'sbom.cdx.json');
  const lockfileText = readFileSync(resolve(repositoryRoot, LOCK_SOURCE), 'utf8');
  const lock = requireObject(JSON.parse(lockfileText), 'SBOM_LOCK_INVALID');
  const result = spawnSync('npm', ['sbom', '--package-lock-only', '--sbom-format', 'cyclonedx'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: withRepositoryNpmCache(process.env),
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  const rawBillOfMaterials = requireObject(JSON.parse(result.stdout), 'SBOM_OUTPUT_INVALID');
  const billOfMaterials = normalizeBillOfMaterials(rawBillOfMaterials, lock, lockfileText);
  validateBillOfMaterials(billOfMaterials, lock, lockfileText, repositoryRoot);
  const serialized = serializeBillOfMaterials(billOfMaterials);
  const checkOnly = process.argv.includes('--check');

  if (checkOnly) {
    if (!existsSync(outputPath)) {
      console.error(`SBOM_EVIDENCE_MISSING path=${outputPath}`);
      process.exit(1);
    }
    if (readFileSync(outputPath, 'utf8') !== serialized) {
      console.error(`SBOM_EVIDENCE_STALE path=${outputPath}`);
      process.exit(1);
    }
    console.log(
      `sbom-evidence current path=${outputPath} components=${String(requireArray(billOfMaterials['components'], 'SBOM_COMPONENTS_MISSING').length)} source=package-lock-only`,
    );
    return;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized, 'utf8');
  console.log(
    `sbom-evidence generated path=${outputPath} components=${String(requireArray(billOfMaterials['components'], 'SBOM_COMPONENTS_MISSING').length)} source=package-lock-only`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
