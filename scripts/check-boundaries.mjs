import { resolve } from 'node:path';

import { DOMAIN_AREAS, OWNED_SOURCE_AREAS } from './boundary-policy.mjs';
import { checkSourceBoundaries } from './boundary-checker.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const sourceRoot = resolve(repositoryRoot, 'src');
const result = checkSourceBoundaries(sourceRoot, repositoryRoot);

if (result.violations.length > 0) {
  for (const violation of result.violations) {
    console.error(`BOUNDARY_VIOLATION ${violation}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `boundary-check passed files=${result.filesChecked} owned-areas=${OWNED_SOURCE_AREAS.length} configured-domain-areas=${DOMAIN_AREAS.length} existing-domain-areas=${result.existingDomainAreas}`,
  );
}
