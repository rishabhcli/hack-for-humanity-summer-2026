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
  MINIMUM_REPEATABILITY_TRIALS,
  decomposeError,
  estimateRepeatability,
} from './repeatability';
import { type TrialMeasured, recordTrial } from './trial-outcome';
import {
  type Centimetres,
  type DegreesMagnitude,
  type DegreesSigned,
  type PositiveCount,
  type UnitInterval,
} from './units';

const SEED = 20_260_810;

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

const CALIBRATION: CalibrationRecord = (() => {
  const result = buildCalibrationRecord({
    acceptedSamples: 90,
    algorithmVersion: 1,
    holdDurationMs: 5_000,
    referenceDigest: 'a'.repeat(64),
    sessionId: '4f1b2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    stability: 0.9,
  });
  if (!result.ok) {
    throw new Error('fixture calibration must be valid');
  }
  return result.value;
})();

function trialsWithErrors(errors: readonly number[]): readonly TrialMeasured[] {
  return errors.map((error) => {
    const verdict = evaluateTrialQuality(CLEAN_OBSERVATION, LIMITS, CALIBRATION);
    if (verdict.kind !== 'accepted') {
      throw new Error('fixture observation must pass every quality bound');
    }
    const outcome = recordTrial({
      acceptance: verdict.acceptance,
      calibration: CALIBRATION,
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

describe('the three-way error decomposition', () => {
  it('separates a consistent bias from a symmetric scatter', () => {
    // Every trial overshoots by 4: bias with no scatter.
    const biased = decomposeError(trialsWithErrors([4, 4, 4, 4, 4, 4]));
    expect(biased.ok).toBe(true);
    if (biased.ok) {
      expect(biased.value.constantError).toBeCloseTo(4, 12);
      expect(biased.value.absoluteError).toBeCloseTo(4, 12);
      expect(biased.value.variableError).toBeCloseTo(0, 12);
    }

    // Trials alternate plus and minus 4: no bias, identical absolute error, large scatter.
    const scattered = decomposeError(trialsWithErrors([4, -4, 4, -4, 4, -4]));
    expect(scattered.ok).toBe(true);
    if (scattered.ok) {
      expect(scattered.value.constantError).toBeCloseTo(0, 12);
      expect(scattered.value.absoluteError).toBeCloseTo(4, 12);
      expect(scattered.value.variableError).toBeGreaterThan(4);
    }
  });

  it('refuses a block with too few trials to estimate scatter from', () => {
    for (let count = 0; count < MINIMUM_REPEATABILITY_TRIALS; count += 1) {
      const errors = Array.from({ length: count }, () => 3);
      const decomposition = decomposeError(trialsWithErrors(errors));
      expect(decomposition.ok).toBe(false);
      if (!decomposition.ok) {
        expect(decomposition.code).toBe('STATISTICS_TOO_FEW_TRIALS');
        expect(decomposition.trialCount).toBe(count);
      }
      expect(estimateRepeatability(trialsWithErrors(errors)).ok).toBe(false);
    }
  });

  it('property: absolute error is never below the magnitude of constant error — 600 cases, seed 20260810', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ max: 45, min: -45, noDefaultInfinity: true, noNaN: true }), {
          maxLength: 20,
          minLength: MINIMUM_REPEATABILITY_TRIALS,
        }),
        (errors) => {
          const decomposition = decomposeError(trialsWithErrors(errors));
          expect(decomposition.ok).toBe(true);
          if (decomposition.ok) {
            // |mean(x)| <= mean(|x|) by the triangle inequality: a bias can never exceed the
            // average distance from zero, so a decomposition claiming otherwise is wrong.
            expect(decomposition.value.absoluteError + 1e-9).toBeGreaterThanOrEqual(
              Math.abs(decomposition.value.constantError),
            );
            expect(decomposition.value.variableError).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 600, seed: SEED },
    );
  });

  it('property: the noise floor is never smaller than the scatter it derives from — 600 cases, seed 20260810', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ max: 45, min: -45, noDefaultInfinity: true, noNaN: true }), {
          maxLength: 20,
          minLength: MINIMUM_REPEATABILITY_TRIALS,
        }),
        (errors) => {
          const estimate = estimateRepeatability(trialsWithErrors(errors));
          expect(estimate.ok).toBe(true);
          if (estimate.ok) {
            // MDC95 = 1.96 * sqrt(2) * SEM, a multiplier well above 1, so the floor always
            // exceeds the raw scatter. An MDC below its own SEM would mean the instrument
            // claiming to detect changes smaller than a single measurement's error.
            expect(estimate.value.minimalDetectableChange).toBeGreaterThanOrEqual(
              estimate.value.standardErrorOfMeasurement,
            );
          }
        },
      ),
      { numRuns: 600, seed: SEED },
    );
  });

  it('refuses when the derived noise floor would fall outside the representable angular range', () => {
    // Maximal alternating scatter drives MDC95 above 180 degrees, which is not a representable
    // angular magnitude. Refusing beats reporting a floor the geometry cannot express.
    const estimate = estimateRepeatability(trialsWithErrors([180, -179, 180, -179, 180, -179]));
    expect(estimate.ok).toBe(false);
    if (!estimate.ok) {
      expect(estimate.code).toBe('STATISTICS_VALUE_OUT_OF_RANGE');
    }
  });
});
