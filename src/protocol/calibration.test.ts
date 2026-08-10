import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CALIBRATION_ALGORITHM_VERSION,
  type CalibrationDraft,
  type CalibrationRecord,
  MINIMUM_NEUTRAL_HOLD_MS,
  MINIMUM_REFERENCE_SAMPLES,
  READABLE_CALIBRATION_ALGORITHM_VERSIONS,
  buildCalibrationRecord,
  calibrationsAreComparable,
  parseSessionId,
  restoreCalibrationRecord,
  sameCalibration,
} from './calibration';

const SEED = 20_260_810;

const HEX_DIGITS = [
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
] as const;

const SESSION_A = '4f1b2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const SESSION_B = '9a8b7c6d-5e4f-4321-8765-fedcba987654';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

/** Lowercase hexadecimal strings of a chosen length, as digests would arrive from storage. */
function hexString(range: { maxLength: number; minLength: number }): fc.Arbitrary<string> {
  return fc.array(fc.constantFrom(...HEX_DIGITS), range).map((characters) => characters.join(''));
}

function validDraft(overrides: Partial<CalibrationDraft> = {}): CalibrationDraft {
  return {
    acceptedSamples: 90,
    algorithmVersion: CALIBRATION_ALGORITHM_VERSION,
    holdDurationMs: 5_000,
    referenceDigest: DIGEST_A,
    sessionId: SESSION_A,
    stability: 0.2,
    ...overrides,
  };
}

function buildOrThrow(overrides: Partial<CalibrationDraft> = {}): CalibrationRecord {
  const result = buildCalibrationRecord(validDraft(overrides));
  if (!result.ok) {
    throw new Error(`expected a valid calibration, got ${result.code}`);
  }
  return result.value;
}

describe('I4 — a neutral reference exists only as a versioned, identified record', () => {
  it('accepts a well-formed capture and stamps it with the current algorithm version', () => {
    const record = buildOrThrow();
    expect(record.algorithmVersion).toBe(CALIBRATION_ALGORITHM_VERSION);
    expect(record.sessionId).toBe(SESSION_A);
    expect(record.referenceDigest).toBe(DIGEST_A);
    expect(record.acceptedSamples).toBe(90);
  });

  it('property: a capture too short or too sparse to trust is never turned into a reference — 600 cases, seed 20260810', () => {
    fc.assert(
      fc.property(
        fc.integer({ max: MINIMUM_REFERENCE_SAMPLES - 1, min: -50 }),
        fc.integer({ max: MINIMUM_NEUTRAL_HOLD_MS - 1, min: -5_000 }),
        (samples, holdMs) => {
          const sparse = buildCalibrationRecord(validDraft({ acceptedSamples: samples }));
          expect(sparse.ok).toBe(false);
          if (!sparse.ok) {
            expect(sparse.code).toBe('CALIBRATION_SAMPLE_COUNT_INVALID');
          }

          const brief = buildCalibrationRecord(validDraft({ holdDurationMs: holdMs }));
          expect(brief.ok).toBe(false);
          if (!brief.ok) {
            expect(brief.code).toBe('CALIBRATION_HOLD_TOO_SHORT');
          }
        },
      ),
      { numRuns: 600, seed: SEED },
    );
  });

  it('property: no malformed session identifier is ever accepted — 500 cases, seed 20260810', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.constant(''),
          fc.constant(SESSION_A.toUpperCase()),
          fc.constant(`${SESSION_A} `),
          fc.constant(SESSION_A.replace('-', '')),
          fc.integer(),
          fc.constant(null),
          fc.constant(undefined),
        ),
        (candidate) => {
          const result = buildCalibrationRecord(validDraft({ sessionId: candidate }));
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.code).toBe('CALIBRATION_SESSION_ID_INVALID');
          }
          expect(parseSessionId(candidate).ok).toBe(false);
        },
      ),
      { numRuns: 500, seed: SEED },
    );
  });

  it('property: no digest that is not a full lowercase sha-256 identifies a reference — 500 cases, seed 20260810', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          hexString({ maxLength: 63, minLength: 0 }),
          hexString({ maxLength: 200, minLength: 65 }),
          fc.constant(DIGEST_A.toUpperCase()),
          fc.constant('z'.repeat(64)),
          fc.integer(),
          fc.constant(null),
        ),
        (candidate) => {
          const result = buildCalibrationRecord(validDraft({ referenceDigest: candidate }));
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.code).toBe('CALIBRATION_REFERENCE_DIGEST_INVALID');
          }
        },
      ),
      { numRuns: 500, seed: SEED },
    );
  });

  it('property: a fresh capture claiming any version but the current one is refused — 400 cases, seed 20260810', () => {
    fc.assert(
      fc.property(
        fc
          .oneof(fc.integer(), fc.double({ noDefaultInfinity: true, noNaN: true }), fc.string())
          .filter((value) => value !== CALIBRATION_ALGORITHM_VERSION),
        (version) => {
          const result = buildCalibrationRecord(validDraft({ algorithmVersion: version }));
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.code).toBe('CALIBRATION_ALGORITHM_VERSION_UNSUPPORTED');
          }
        },
      ),
      { numRuns: 400, seed: SEED },
    );
  });

  it('property: a restored record claiming an unreadable version is refused — 400 cases, seed 20260810', () => {
    fc.assert(
      fc.property(
        fc
          .oneof(fc.integer(), fc.string(), fc.constant(null), fc.constant(1.5))
          .filter(
            (value) =>
              typeof value !== 'number' || !READABLE_CALIBRATION_ALGORITHM_VERSIONS.includes(value),
          ),
        (version) => {
          const result = restoreCalibrationRecord(validDraft({ algorithmVersion: version }));
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.code).toBe('CALIBRATION_ALGORITHM_VERSION_UNREADABLE');
          }
        },
      ),
      { numRuns: 400, seed: SEED },
    );
  });

  it('preserves a restored record’s stored version rather than upgrading it', () => {
    const restored = restoreCalibrationRecord(validDraft({ algorithmVersion: 1 }));
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.value.algorithmVersion).toBe(1);
    }
  });

  it('refuses a stability value outside the unit interval', () => {
    for (const stability of [-0.1, 1.1, Number.NaN, 'high', null]) {
      const result = buildCalibrationRecord(validDraft({ stability }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('CALIBRATION_STABILITY_INVALID');
      }
    }
  });
});

describe('I4 — calibrations are compared, never silently normalized', () => {
  it('treats two records as the same calibration only when session and reference both agree', () => {
    const base = buildOrThrow();
    expect(sameCalibration(base, buildOrThrow())).toBe(true);
    expect(sameCalibration(base, buildOrThrow({ sessionId: SESSION_B }))).toBe(false);
    expect(sameCalibration(base, buildOrThrow({ referenceDigest: DIGEST_B }))).toBe(false);
  });

  it('refuses comparability across algorithm versions even when every other field matches', () => {
    const current = buildOrThrow();
    // A record as it would be restored from a session captured by a future build.
    const future: CalibrationRecord = {
      ...current,
      algorithmVersion: current.algorithmVersion + 1,
    };

    expect(calibrationsAreComparable(current, current)).toBe(true);
    expect(calibrationsAreComparable(current, future)).toBe(false);
    expect(sameCalibration(current, future)).toBe(false);
  });

  it('property: comparability is reflexive, symmetric, and version-determined — 500 cases, seed 20260810', () => {
    const versioned = fc.integer({ max: 8, min: 1 }).map((algorithmVersion): CalibrationRecord => ({
      ...buildOrThrow(),
      algorithmVersion,
    }));

    fc.assert(
      fc.property(versioned, versioned, (left, right) => {
        expect(calibrationsAreComparable(left, left)).toBe(true);
        expect(calibrationsAreComparable(left, right)).toBe(calibrationsAreComparable(right, left));
        expect(calibrationsAreComparable(left, right)).toBe(
          left.algorithmVersion === right.algorithmVersion,
        );
      }),
      { numRuns: 500, seed: SEED },
    );
  });
});
