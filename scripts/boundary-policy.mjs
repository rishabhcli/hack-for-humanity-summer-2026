export const DOMAIN_AREAS = Object.freeze([
  'measurement',
  'protocol',
  'quality',
  'report',
  'vision',
]);

export const OWNED_SOURCE_AREAS = Object.freeze([...DOMAIN_AREAS, 'ui-accessibility']);
export const COMPOSITION_ROOT_FILES = Object.freeze(['main.ts']);

/**
 * Domain modules are pure by default. A third-party package can be added here
 * only after its adapter boundary and dependency review are committed.
 * @type {readonly string[]}
 */
export const DOMAIN_EXTERNAL_ALLOWLIST = Object.freeze([]);

/**
 * @param {{sourceArea: string, specifier: string, targetArea?: string}} candidate
 * @returns {string | null}
 */
export function boundaryViolation({ sourceArea, specifier, targetArea }) {
  if (!DOMAIN_AREAS.includes(sourceArea)) {
    return null;
  }

  if (specifier.startsWith('.')) {
    if (targetArea === undefined || !DOMAIN_AREAS.includes(targetArea)) {
      return `imports non-domain local area ${targetArea ?? 'unresolved'}`;
    }
    return null;
  }

  if (!DOMAIN_EXTERNAL_ALLOWLIST.includes(specifier)) {
    return `imports non-allowlisted external package ${specifier}`;
  }
  return null;
}

/** @param {string} repositoryRelativePath @returns {string | null} */
export function sourceOwnershipViolation(repositoryRelativePath) {
  const normalizedPath = repositoryRelativePath.replaceAll('\\', '/');
  if (COMPOSITION_ROOT_FILES.includes(normalizedPath)) {
    return null;
  }
  const sourceArea = normalizedPath.split('/')[0] ?? '';
  if (!OWNED_SOURCE_AREAS.includes(sourceArea)) {
    return `source file is outside an owned area path=${normalizedPath}`;
  }
  return null;
}
