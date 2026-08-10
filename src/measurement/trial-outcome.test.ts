import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { type CalibrationRecord, buildCalibrationRecord } from '../protocol/calibration';
import {
  QUALITY_LIMITS_VERSION,
  type QualityAcceptance,
  type QualityLimits,
  type QualityObservation,
  evaluateTrialQuality,
} from '../quality/trial-quality';
import {
  MINIMUM_ENDPOINT_SAMPLES,
  type RotationDirection,
  type TrialInput,
  measuredTrialsFor,
  recordTrial,
  withholdForQuality,
} from './trial-outcome';
import {
  type Centimetres,
  type DegreesMagnitude,
  type DegreesSigned,
  type PositiveCount,
  type UnitInterval,
} from './units';

const SEED = 20_260_810;
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function calibrationWith(referenceDigest: string, stability = 0.4): CalibrationRecord {
  const result = buildCalibrationRecord({
    acceptedSamples: 90,
    algorithmVersion: 1,
    holdDurationMs: 5_000,
    referenceDigest,
    sessionId: '4f1b2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    stability,
  });
  if (!result.ok) {
    throw new Error('fixture calibration must be valid');
  }
  return result.value;
}

const CALIBRATION = calibrationWith(DIGEST_A);
const OTHER_CALIBRATION = calibrationWith(DIGEST_B);

const LIMITS: QualityLimits = {
  cameraMotionMaxDeg: 0.5 as DegreesMagnitude,
  faceDistanceMaxCm: 80 as Centimetres,
  faceDistanceMinCm: 35 as Centimetres,
  headRollMaxDeg: 20 as DegreesMagnitude,
  headYawMaxDeg: 15 as DegreesMagnitude,
  illuminationMax: 0.95 as UnitInterval,
  illuminationMin: 0.15 as UnitInterval,
  illuminationUniformityMin: 0.5 as UnitInterval,
  poseConfidenceMin: 0.8 as UnitInterval,
  torsoMotionMaxDeg: 2 as DegreesMagnitude,
  trackedFrameRatioMin: 0.9 as UnitInterval,
  version: QUALITY_LIMITS_VERSION,
  visibleLandmarkRatioMin: 0.9 as UnitInterval,
};

const CLEAN_OBSERVATION: QualityObservation = {
  cameraMotionDeg: 0.05 as DegreesMagnitude,
  faceDistanceCm: 55 as Centimetres,
  headRollDeg: 1 as DegreesSigned,
  headYawDeg: 2 as DegreesSigned,
  illumination: 0.55 as UnitInterval,
  illuminationUniformity: 0.85 as UnitInterval,
  poseConfidence: 0.95 as UnitInterval,
  torsoMotionDeg: 0.3 as DegreesMagnitude,
  trackedFrameRatio: 0.99 as UnitInterval,
  visibleLandmarkRatio: 0.98 as UnitInterval,
};

function acceptanceFor(calibration: CalibrationRecord): QualityAcceptance {
  const verdict = evaluateTrialQuality(CLEAN_OBSERVATION, LIMITS, calibration);
  if (verdict.kind !== 'accepted') {
    throw new Error('fixture observation must pass every quality bound');
  }
  return verdict.acceptance;
}

function validInput(overrides: Partial<TrialInput> = {}): TrialInput {
  return {
    acceptance: acceptanceFor(CALIBRATION),
    calibration: CALIBRATION,
    constantError: 3.4 as DegreesSigned,
    direction: 'left',
    endpointSamples: 30 as PositiveCount,
    stationarity: 0.1 as UnitInterval,
    ...overrides,
  };
}

describe('I2 — a number cannot exist without a genuine quality acceptance', () => {
  it('measures a trial whose acceptance, sample count, and stationarity all hold', () => {
    const outcome = recordTrial(validInput());
    expect(outcome.kind).toBe('measured');
    if (outcome.kind === 'measured') {
      expect(outcome.absoluteError).toBeCloseTo(3.4, 10);
      expect(outcome.constantError).toBeCloseTo(3.4, 10);
      expect(outcome.referenceDigest).toBe(DIGEST_A);
      expect(outcome.direction).toBe('left');
    }
  });

  it('property: a forged acceptance never yields a measured outcome — 1000 cases, seed 20260810', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.record({
            calibrationDigest: fc.constant(DIGEST_A),
            checkedKeys: fc.constant([]),
            limitsVersion: fc.constant(QUALITY_LIMITS_VERSION),
            observation: fc.constant(CLEAN_OBSERVATION),
          }),
          fc.object(),
          fc.constant({}),
          fc.constant(null),
          fc.string(),
        ),
        (forged) => {
          const outcome = recordTrial(
            validInput({ acceptance: forged as unknown as QualityAcceptance }),
          );
          expect(outcome.kind).toBe('withheld');
          if (outcome.kind === 'withheld') {
            expect(outcome.code).toBe('TRIAL_ACCEPTANCE_NOT_AUTHENTIC');
          }
        },
      ),
      { numRuns: 1000, seed: SEED },
    );
  });

  it('withholds when a structurally identical clone of a genuine acceptance is supplied', () => {
    const genuine = acceptanceFor(CALIBRATION);
    const outcome = recordTrial(validInput({ acceptance: { ...genuine } }));
    expect(outcome.kind).toBe('withheld');
    if (outcome.kind === 'withheld') {
      expect(outcome.code).toBe('TRIAL_ACCEPTANCE_NOT_AUTHENTIC');
    }
  });

  it('withholds when an acceptance from a different calibration is reused', () => {
    const outcome = recordTrial(
      validInput({ acceptance: acceptanceFor(OTHER_CALIBRATION), calibration: CALIBRATION }),
    );
    expect(outcome.kind).toBe('withheld');
    if (outcome.kind === 'withheld') {
      expect(outcome.code).toBe('TRIAL_ACCEPTANCE_WRONG_CALIBRATION');
    }
  });

  it('property: an endpoint window below the minimum sample count is never measured — 400 cases, seed 20260810', () => {
    fc.assert(
      fc.property(fc.integer({ max: MINIMUM_ENDPOINT_SAMPLES - 1, min: 1 }), (samples) => {
        const outcome = recordTrial(validInput({ endpointSamples: samples as PositiveCount }));
        expect(outcome.kind).toBe('withheld');
        if (outcome.kind === 'withheld') {
          expect(outcome.code).toBe('TRIAL_SAMPLE_COUNT_INSUFFICIENT');
        }
      }),
      { numRuns: 400, seed: SEED },
    );
  });

  it('property: an endpoint noisier than the session’s own jitter is never measured — 600 cases, seed 20260810', () => {
    fc.assert(
      fc.property(
        fc.double({ max: 1, min: 0, noDefaultInfinity: true, noNaN: true }),
        (stationarity) => {
          const outcome = recordTrial(validInput({ stationarity: stationarity as UnitInterval }));
          const shouldMeasure = stationarity <= CALIBRATION.stability;
          expect(outcome.kind === 'measured').toBe(shouldMeasure);
          if (outcome.kind === 'withheld') {
            expect(outcome.code).toBe('TRIAL_ENDPOINT_NOT_STATIONARY');
          }
        },
      ),
      { numRuns: 600, seed: SEED },
    );
  });

  it('property: absolute error is the magnitude of constant error, never negative — 1000 cases, seed 20260810', () => {
    fc.assert(
      fc.property(
        fc
          .double({ max: 180, min: -180, noDefaultInfinity: true, noNaN: true })
          .filter((value) => value > -180),
        (constantError) => {
          const outcome = recordTrial(
            validInput({ constantError: constantError as DegreesSigned }),
          );
          expect(outcome.kind).toBe('measured');
          if (outcome.kind === 'measured') {
            expect(outcome.absoluteError).toBeGreaterThanOrEqual(0);
            expect(outcome.absoluteError).toBe(Math.abs(constantError));
          }
        },
      ),
      { numRuns: 1000, seed: SEED },
    );
  });
});

describe('I2 — a quality refusal produces a withheld outcome carrying its reasons', () => {
  it('withholds with the gate’s own reasons and no number', () => {
    const verdict = evaluateTrialQuality(
      { ...CLEAN_OBSERVATION, poseConfidence: 0.1 as UnitInterval },
      LIMITS,
      CALIBRATION,
    );
    expect(verdict.kind).toBe('refused');
    if (verdict.kind === 'refused') {
      const outcome = withholdForQuality('right', CALIBRATION, verdict.reasons);
      expect(outcome.kind).toBe('withheld');
      expect(outcome.code).toBe('TRIAL_QUALITY_REFUSED');
      expect(outcome.qualityReasons).toHaveLength(1);
      expect(outcome.userMessage).not.toMatch(/\d/u);
      expect(Object.keys(outcome)).not.toContain('absoluteError');
    }
  });
});

describe('I4 — trials are never pooled across calibrations', () => {
  it('property: a summary only ever draws on trials from its own reference — 500 cases, seed 20260810', () => {
    const directions: readonly RotationDirection[] = ['down', 'left', 'right', 'up'];

    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { maxLength: 12, minLength: 1 }),
        fc.array(fc.integer({ max: 3, min: 0 }), { maxLength: 12, minLength: 1 }),
        (useOwnCalibration, directionIndices) => {
          const outcomes = useOwnCalibration.map((own, index) => {
            const calibration = own ? CALIBRATION : OTHER_CALIBRATION;
            const direction =
              directions[(directionIndices[index] ?? 0) % directions.length] ?? 'left';
            return recordTrial(
              validInput({
                acceptance: acceptanceFor(calibration),
                calibration,
                direction,
              }),
            );
          });

          const selected = measuredTrialsFor(CALIBRATION, outcomes);
          expect(selected).toHaveLength(useOwnCalibration.filter(Boolean).length);
          for (const trial of selected) {
            expect(trial.referenceDigest).toBe(DIGEST_A);
          }
        },
      ),
      { numRuns: 500, seed: SEED },
    );
  });
});
