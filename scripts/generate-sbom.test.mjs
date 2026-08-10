import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  lockedPackages,
  normalizeBillOfMaterials,
  serializeBillOfMaterials,
  validateBillOfMaterials,
} from './generate-sbom.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const lockfileText = readFileSync(resolve(repositoryRoot, 'package-lock.json'), 'utf8');
const lock = JSON.parse(lockfileText);
const committedText = readFileSync(
  resolve(repositoryRoot, 'evidence', 'tier-0', 'sbom.cdx.json'),
  'utf8',
);
const committedBillOfMaterials = JSON.parse(committedText);

describe('lockfile-only CycloneDX evidence', () => {
  it('represents every locked identity and both Darwin and Linux native variants', () => {
    expect(() =>
      validateBillOfMaterials(committedBillOfMaterials, lock, lockfileText, repositoryRoot),
    ).not.toThrow();

    const lockedIdentities = new Set(lockedPackages(lock).map((entry) => entry.identity));
    const componentNames = new Set(
      /** @type {Array<{name: string}>} */ (committedBillOfMaterials.components).map(
        (component) => component.name,
      ),
    );
    expect(committedBillOfMaterials.components).toHaveLength(lockedIdentities.size);
    for (const requiredName of [
      '@esbuild/darwin-arm64',
      '@esbuild/linux-x64',
      '@rollup/rollup-darwin-arm64',
      '@rollup/rollup-linux-x64-gnu',
    ]) {
      expect(componentNames.has(requiredName), requiredName).toBe(true);
    }
  });

  it('normalizes order and nondeterministic npm fields byte-for-byte', () => {
    const reordered = JSON.parse(JSON.stringify(committedBillOfMaterials));
    reordered.serialNumber = 'urn:uuid:nondeterministic';
    reordered.metadata.timestamp = '2099-01-01T00:00:00.000Z';
    reordered.metadata.component.name = 'host-directory-name';
    reordered.components.reverse();
    reordered.dependencies.reverse();
    for (const dependency of reordered.dependencies) {
      dependency.dependsOn.reverse();
    }

    const normalized = normalizeBillOfMaterials(reordered, lock, lockfileText);
    expect(serializeBillOfMaterials(normalized)).toBe(committedText);
  });
});
