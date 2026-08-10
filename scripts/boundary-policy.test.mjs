import { describe, expect, it } from 'vitest';

import { boundaryViolation, sourceOwnershipViolation } from './boundary-policy.mjs';

describe('source ownership policy', () => {
  it.each(['foo.ts', 'utils/parser.ts', 'adapters/cloud.ts', 'app/surface.ts'])(
    'rejects an unowned source path %s',
    (path) => {
      expect(sourceOwnershipViolation(path)).toContain('outside an owned area');
    },
  );

  it.each(['main.ts', 'measurement/error.ts', 'ui-accessibility/surface.ts'])(
    'accepts an explicitly owned source path %s',
    (path) => {
      expect(sourceOwnershipViolation(path)).toBeNull();
    },
  );
});

describe('domain import boundary policy', () => {
  it.each(['ui-accessibility', 'app', 'adapters', 'transport', 'unknown'])(
    'rejects a domain import of the %s area',
    (targetArea) => {
      expect(
        boundaryViolation({
          sourceArea: 'measurement',
          specifier: `../${targetArea}/surface`,
          targetArea,
        }),
      ).toContain('non-domain local area');
    },
  );

  it.each([
    'react',
    '@aws-sdk/client-s3',
    'node:fs',
    'some-unreviewed-package',
    'https://example.invalid/module.js',
  ])('rejects the non-allowlisted external import %s', (specifier) => {
    expect(boundaryViolation({ sourceArea: 'quality', specifier })).toContain(
      'non-allowlisted external package',
    );
  });

  it('allows typed domain-to-domain collaboration', () => {
    expect(
      boundaryViolation({
        sourceArea: 'measurement',
        specifier: '../quality/refusal',
        targetArea: 'quality',
      }),
    ).toBeNull();
  });

  it('does not impose domain rules on the application composition root', () => {
    expect(boundaryViolation({ sourceArea: 'app', specifier: 'react' })).toBeNull();
  });
});
