import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(resolve(repositoryRoot, 'package-lock.json'), 'utf8'));
const playwrightBrowserManifest =
  /** @type {{browsers?: Array<{browserVersion?: string, name: string, revision: string}>}} */ (
    JSON.parse(
      readFileSync(
        resolve(repositoryRoot, 'node_modules', 'playwright-core', 'browsers.json'),
        'utf8',
      ),
    )
  );
const outputPath = resolve(repositoryRoot, 'evidence', 'tier-0', 'dependencies.json');

/** @param {Record<string, number>} counts @param {string} key @returns {void} */
function increment(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

/** @type {Record<string, number>} */
const licenseCounts = {};
/** @type {Set<string>} */
const registryOrigins = new Set();
/** @type {string[]} */
const integrityMissing = [];
/** @type {string[]} */
const installScriptPackages = [];
let nativeOrPlatformConstrainedPackages = 0;
let transitiveEntries = 0;

for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (path === '' || typeof entry !== 'object' || entry === null) {
    continue;
  }
  transitiveEntries += 1;
  const packageEntry = /** @type {Record<string, unknown>} */ (entry);
  const packageName = path.replace(/^node_modules\//u, '');
  if (typeof packageEntry['license'] === 'string') {
    increment(licenseCounts, packageEntry['license']);
  }
  if (typeof packageEntry['resolved'] === 'string') {
    const resolved = new URL(packageEntry['resolved']);
    registryOrigins.add(resolved.origin);
    if (typeof packageEntry['integrity'] !== 'string') {
      integrityMissing.push(packageName);
    }
  }
  if (packageEntry['hasInstallScript'] === true) {
    installScriptPackages.push(`${packageName}@${String(packageEntry['version'] ?? 'unknown')}`);
  }
  if (Array.isArray(packageEntry['cpu']) || Array.isArray(packageEntry['os'])) {
    nativeOrPlatformConstrainedPackages += 1;
  }
}

const directDependencies = Object.entries(manifest.devDependencies ?? {})
  .map(([name, declaredVersion]) => {
    const entry = lock.packages?.[`node_modules/${name}`];
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`DEPENDENCY_LOCK_ENTRY_MISSING name=${name}`);
    }
    return {
      declaredVersion,
      license: entry.license ?? 'UNKNOWN',
      name,
      resolvedVersion: entry.version,
    };
  })
  .sort((left, right) => left.name.localeCompare(right.name));

const playwrightBrowsers = (playwrightBrowserManifest.browsers ?? [])
  .filter((browser) => ['chromium', 'chromium-headless-shell', 'ffmpeg'].includes(browser.name))
  .map((browser) => ({
    browserVersion: browser.browserVersion ?? null,
    name: browser.name,
    revision: browser.revision,
  }));

const evidence = {
  allowScripts: manifest.allowScripts ?? {},
  command: 'npm run evidence:dependencies',
  directDependencies,
  installScriptPackages: installScriptPackages.sort(),
  integrityMissing: integrityMissing.sort(),
  licenseCounts: Object.fromEntries(
    Object.entries(licenseCounts).sort(([left], [right]) => left.localeCompare(right)),
  ),
  lockfileVersion: lock.lockfileVersion,
  nativeOrPlatformConstrainedPackages,
  npmAuditCommand: 'npm audit --audit-level=low',
  playwrightBrowserCache: '.dev/cache/ms-playwright',
  playwrightBrowsers,
  registryOrigins: [...registryOrigins].sort(),
  repository: manifest.name,
  seed: 'not-applicable-lockfile-inventory',
  snapshotDate: '2026-08-10',
  transitiveEntries,
};
const serialized = `${JSON.stringify(evidence, null, 2)}\n`;

if (process.argv.includes('--check')) {
  if (!existsSync(outputPath) || readFileSync(outputPath, 'utf8') !== serialized) {
    throw new Error('DEPENDENCY_EVIDENCE_STALE run="npm run evidence:dependencies"');
  }
  console.log(
    `dependency-evidence current direct=${directDependencies.length} transitive=${String(transitiveEntries)}`,
  );
} else {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized, 'utf8');
  console.log(
    `dependency-evidence generated path=evidence/tier-0/dependencies.json direct=${directDependencies.length} transitive=${String(transitiveEntries)}`,
  );
}
