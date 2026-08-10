import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { type CalibrationRecord, buildCalibrationRecord } from '../protocol/calibration';
import {
  QUALITY_LIMITS_VERSION,
  type QualityLimits,
  type QualityObservation,
  evaluateTrialQuality,
} from '../quality/trial-quality';
import {
  type ChangeVerdict,
  type MeasurementBlock,
  assertsChange,
  combinedMinimalDetectableChange,
  compareBlocks,
  sessionOf,
} from './change-claim';
import { MDC95_Z, type RepeatabilityEstimate, estimateRepeatability } from './repeatability';
import { type TrialMeasured, recordTrial } from './trial-outcome';
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

function calibrationWith(referenceDigest: string): CalibrationRecord {
  const result = buildCalibrationRecord({
    acceptedSamples: 90,
    algorithmVersion: 1,
    holdDurationMs: 5_000,
    referenceDigest,
    sessionId: '4f1b2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    stability: 0.9,
  });
  if (!result.ok) {
    throw new Error('fixture calibration must be valid');
  }
  return result.value;
}

const CALIBRATION = calibrationWith(DIGEST_A);
const OTHER_REFERENCE = calibrationWith(DIGEST_B);

/** Builds real measured trials by driving the whole gate, so no fixture bypasses an invariant. */
function trialsWithErrors(
  errors: readonly number[],
  calibration: CalibrationRecord = CALIBRATION,
): readonly TrialMeasured[] {
  return errors.map((error) => {
    const verdict = evaluateTrialQuality(CLEAN_OBSERVATION, LIMITS, calibration);
    if (verdict.kind !== 'accepted') {
      throw new Error('fixture observation must pass every quality bound');
    }
    const outcome = recordTrial({
      acceptance: verdict.acceptance,
      calibration,
      constantError: error as DegreesSigned,
      direction: 'left',
      endpointSamples: 30 as PositiveCount,
      stationarity: 0.1 as UnitInterval,
    });
    if (outcome.kind !== 'measured') {
      throw new Error(`fixture trial must be measured, got ${outcome.code}`);
    }
    return outcome;
  });
}

function repeatabilityFor(
  errors: readonly number[],
  calibration: CalibrationRecord = CALIBRATION,
): RepeatabilityEstimate {
  const estimate = estimateRepeatability(trialsWithErrors(errors, calibration));
  if (!estimate.ok) {
    throw new Error(`fixture repeatability must be estimable, got ${estimate.code}`);
  }
  return estimate.value;
}

function blockOf(
  label: 'baseline' | 'retest',
  errors: readonly number[],
  calibration: CalibrationRecord = CALIBRATION,
): MeasurementBlock {
  return { calibration, label, repeatability: repeatabilityFor(errors, calibration) };
}

/** Six trials with visible scatter, so the MDC is a real number rather than zero. */
const NOISY = [2, 5, 3, 6, 1, 4];
/** The same scatter shifted far down: a change that should clear the combined noise floor. */
const NOISY_MUCH_BETTER = [-42, -39, -41, -38, -43, -40];
/** A shift far smaller than the scatter. */
const NOISY_SLIGHTLY_BETTER = [1.9, 4.9, 2.9, 5.9, 0.9, 3.9];

describe('I3 — every change verdict carries the noise floor it was judged against', () => {
  it('reports a change only when it exceeds the combined minimal detectable change', () => {
    const verdict = compareBlocks(blockOf('baseline', NOISY), blockOf('retest', NOISY_MUCH_BETTER));
    expect(verdict.kind).toBe('exceeds-measurement-error');
    if (verdict.kind === 'exceeds-measurement-error') {
      expect(verdict.direction).toBe('higher');
      expect(verdict.minimalDetectableChange).toBeGreaterThan(0);
      expect(Math.abs(verdict.observedChange)).toBeGreaterThan(verdict.minimalDetectableChange);
    }
  });

  it('refuses to call a difference smaller than the noise floor a change', () => {
    const verdict = compareBlocks(
      blockOf('baseline', NOISY),
      blockOf('retest', NOISY_SLIGHTLY_BETTER),
    );
    expect(verdict.kind).toBe('within-measurement-error');
    expect(assertsChange(verdict)).toBe(false);
    if (verdict.kind === 'within-measurement-error') {
      expect(verdict.statement).toContain('not a change');
      expect(Math.abs(verdict.observedChange)).toBeLessThanOrEqual(verdict.minimalDetectableChange);
    }
  });

  it('property: no verdict ever omits the minimal detectable change — 800 cases, seed 20260810', () => {
    const errorBlock = fc.array(
      fc.double({ max: 30, min: -30, noDefaultInfinity: true, noNaN: true }),
      { maxLength: 12, minLength: 6 },
    );

    fc.assert(
      fc.property(errorBlock, errorBlock, (baselineErrors, retestErrors) => {
        const verdict = compareBlocks(
          blockOf('baseline', baselineErrors),
          blockOf('retest', retestErrors),
        );
        if (verdict.kind !== 'refused') {
          expect(verdict.minimalDetectableChange).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(verdict.minimalDetectableChange)).toBe(true);
          expect(Number.isFinite(verdict.observedChange)).toBe(true);
        }
      }),
      { numRuns: 800, seed: SEED },
    );
  });

  it('property: a change is asserted if and only if it exceeds the noise floor — 800 cases, seed 20260810', () => {
    const errorBlock = fc.array(
      fc.double({ max: 30, min: -30, noDefaultInfinity: true, noNaN: true }),
      { maxLength: 12, minLength: 6 },
    );

    fc.assert(
      fc.property(errorBlock, errorBlock, (baselineErrors, retestErrors) => {
        const baseline = blockOf('baseline', baselineErrors);
        const retest = blockOf('retest', retestErrors);
        const verdict = compareBlocks(baseline, retest);
        if (verdict.kind === 'refused') {
          return;
        }

        const floor = combinedMinimalDetectableChange(baseline.repeatability, retest.repeatability);
        expect(floor).not.toBeNull();
        if (floor !== null) {
          expect(assertsChange(verdict)).toBe(Math.abs(verdict.observedChange) > floor);
        }
      }),
      { numRuns: 800, seed: SEED },
    );
  });

  it('property: identical blocks are never reported as a change — 400 cases, seed 20260810', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ max: 30, min: -30, noDefaultInfinity: true, noNaN: true }), {
          maxLength: 12,
          minLength: 6,
        }),
        (errors) => {
          const verdict = compareBlocks(blockOf('baseline', errors), blockOf('retest', errors));
          expect(assertsChange(verdict)).toBe(false);
        },
      ),
      { numRuns: 400, seed: SEED },
    );
  });
});

describe('I3 × I4 — incomparable measurements are refused, never normalized', () => {
  it('refuses a comparison across calibration algorithm versions', () => {
    const baseline = blockOf('baseline', NOISY);
    const retest: MeasurementBlock = {
      ...blockOf('retest', NOISY_MUCH_BETTER),
      calibration: { ...CALIBRATION, algorithmVersion: CALIBRATION.algorithmVersion + 1 },
    };

    const verdict = compareBlocks(baseline, retest);
    expect(verdict.kind).toBe('refused');
    if (verdict.kind === 'refused') {
      expect(verdict.code).toBe('CHANGE_REFUSED_CALIBRATION_VERSION_MISMATCH');
    }
  });

  it('refuses a comparison across different neutral references', () => {
    const verdict = compareBlocks(
      blockOf('baseline', NOISY),
      blockOf('retest', NOISY_MUCH_BETTER, OTHER_REFERENCE),
    );
    expect(verdict.kind).toBe('refused');
    if (verdict.kind === 'refused') {
      expect(verdict.code).toBe('CHANGE_REFUSED_DIFFERENT_NEUTRAL_REFERENCE');
    }
  });

  it('refuses two blocks supplied in the wrong roles', () => {
    const verdict = compareBlocks(blockOf('retest', NOISY), blockOf('retest', NOISY));
    expect(verdict.kind).toBe('refused');
    if (verdict.kind === 'refused') {
      expect(verdict.code).toBe('CHANGE_REFUSED_BLOCK_ORDER_INVALID');
    }
  });

  it('property: a refused comparison never asserts a change — 400 cases, seed 20260810', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ max: 30, min: -30, noDefaultInfinity: true, noNaN: true }), {
          maxLength: 12,
          minLength: 6,
        }),
        (errors) => {
          const verdicts: readonly ChangeVerdict[] = [
            compareBlocks(blockOf('retest', errors), blockOf('retest', errors)),
            compareBlocks(blockOf('baseline', errors), blockOf('retest', errors, OTHER_REFERENCE)),
          ];
          for (const verdict of verdicts) {
            expect(verdict.kind).toBe('refused');
            expect(assertsChange(verdict)).toBe(false);
            expect(verdict.statement.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 400, seed: SEED },
    );
  });

  it('names the session a block belongs to', () => {
    expect(sessionOf(blockOf('baseline', NOISY))).toBe(CALIBRATION.sessionId);
  });
});

describe('the noise floor is derived, never asserted', () => {
  it('computes MDC95 as 1.96 * sqrt(2) * SEM from the trial scatter', () => {
    const estimate = repeatabilityFor(NOISY);
    expect(estimate.standardErrorOfMeasurement).toBeCloseTo(
      estimate.decomposition.variableError,
      12,
    );
    expect(estimate.minimalDetectableChange).toBeCloseTo(
      MDC95_Z * Math.SQRT2 * estimate.standardErrorOfMeasurement,
      12,
    );
  });

  it('combines two blocks’ floors in quadrature rather than using one of them', () => {
    const baseline = repeatabilityFor(NOISY);
    const retest = repeatabilityFor(NOISY_MUCH_BETTER);
    const combined = combinedMinimalDetectableChange(baseline, retest);
    expect(combined).not.toBeNull();
    if (combined !== null) {
      expect(combined).toBeGreaterThanOrEqual(baseline.minimalDetectableChange);
      expect(combined).toBeGreaterThanOrEqual(retest.minimalDetectableChange);
      expect(combined).toBeCloseTo(
        Math.hypot(baseline.minimalDetectableChange, retest.minimalDetectableChange),
        12,
      );
    }
  });
});
