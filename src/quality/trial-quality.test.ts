import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { type CalibrationRecord, buildCalibrationRecord } from '../protocol/calibration';
import {
  type Centimetres,
  type DegreesMagnitude,
  type DegreesSigned,
  type UnitInterval,
} from '../measurement/units';
import {
  QUALITY_LIMITS_VERSION,
  type QualityLimits,
  type QualityObservation,
  type QualityRefusalCode,
  evaluateTrialQuality,
  isAuthenticAcceptance,
} from './trial-quality';

const SEED = 20_260_810;

const CALIBRATION: CalibrationRecord = (() => {
  const result = buildCalibrationRecord({
    acceptedSamples: 90,
    algorithmVersion: 1,
    holdDurationMs: 5_000,
    referenceDigest: 'a'.repeat(64),
    sessionId: '4f1b2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    stability: 0.2,
  });
  if (!result.ok) {
    throw new Error('fixture calibration must be valid');
  }
  return result.value;
})();

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

/** An observation comfortably inside every bound. */
function cleanObservation(overrides: Partial<QualityObservation> = {}): QualityObservation {
  return {
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
    ...overrides,
  };
}

function codesFor(observation: QualityObservation): readonly QualityRefusalCode[] {
  const verdict = evaluateTrialQuality(observation, LIMITS, CALIBRATION);
  return verdict.kind === 'refused' ? verdict.reasons.map((reason) => reason.code) : [];
}

describe('I2 — each failing condition produces its own distinct refusal', () => {
  it('accepts an observation inside every bound and scopes the acceptance to the calibration', () => {
    const verdict = evaluateTrialQuality(cleanObservation(), LIMITS, CALIBRATION);
    expect(verdict.kind).toBe('accepted');
    if (verdict.kind === 'accepted') {
      expect(isAuthenticAcceptance(verdict.acceptance)).toBe(true);
      expect(verdict.acceptance.calibrationDigest).toBe(CALIBRATION.referenceDigest);
      expect(verdict.acceptance.limitsVersion).toBe(QUALITY_LIMITS_VERSION);
      expect(verdict.acceptance.checkedKeys).toHaveLength(9);
    }
  });

  it('names the specific condition that failed rather than a generic rejection', () => {
    expect(codesFor(cleanObservation({ faceDistanceCm: 20 as Centimetres }))).toEqual([
      'QUALITY_FACE_TOO_NEAR',
    ]);
    expect(codesFor(cleanObservation({ faceDistanceCm: 120 as Centimetres }))).toEqual([
      'QUALITY_FACE_TOO_FAR',
    ]);
    expect(codesFor(cleanObservation({ illumination: 0.02 as UnitInterval }))).toEqual([
      'QUALITY_ILLUMINATION_TOO_LOW',
    ]);
    expect(codesFor(cleanObservation({ illumination: 0.99 as UnitInterval }))).toEqual([
      'QUALITY_ILLUMINATION_TOO_HIGH',
    ]);
    expect(codesFor(cleanObservation({ illuminationUniformity: 0.1 as UnitInterval }))).toEqual([
      'QUALITY_ILLUMINATION_UNEVEN',
    ]);
    expect(codesFor(cleanObservation({ visibleLandmarkRatio: 0.5 as UnitInterval }))).toEqual([
      'QUALITY_LANDMARKS_OCCLUDED',
    ]);
    expect(codesFor(cleanObservation({ headYawDeg: -40 as DegreesSigned }))).toEqual([
      'QUALITY_HEAD_YAW_OUT_OF_RANGE',
    ]);
    expect(codesFor(cleanObservation({ headRollDeg: 35 as DegreesSigned }))).toEqual([
      'QUALITY_HEAD_ROLL_OUT_OF_RANGE',
    ]);
    expect(codesFor(cleanObservation({ poseConfidence: 0.4 as UnitInterval }))).toEqual([
      'QUALITY_POSE_CONFIDENCE_LOW',
    ]);
    expect(codesFor(cleanObservation({ cameraMotionDeg: 3 as DegreesMagnitude }))).toEqual([
      'QUALITY_CAMERA_MOTION_DETECTED',
    ]);
    expect(codesFor(cleanObservation({ torsoMotionDeg: 9 as DegreesMagnitude }))).toEqual([
      'QUALITY_TORSO_MOTION_NOT_SEPARABLE',
    ]);
    expect(codesFor(cleanObservation({ trackedFrameRatio: 0.4 as UnitInterval }))).toEqual([
      'QUALITY_TRACKING_DISCONTINUOUS',
    ]);
  });

  it('reports every violated condition at once so a retake can fix them together', () => {
    const codes = codesFor(
      cleanObservation({
        faceDistanceCm: 15 as Centimetres,
        illumination: 0.01 as UnitInterval,
        poseConfidence: 0.1 as UnitInterval,
      }),
    );
    expect(codes).toContain('QUALITY_FACE_TOO_NEAR');
    expect(codes).toContain('QUALITY_ILLUMINATION_TOO_LOW');
    expect(codes).toContain('QUALITY_POSE_CONFIDENCE_LOW');
    expect(codes).toHaveLength(3);
  });

  it('carries the observed value, the violated bound, and a non-diagnostic message', () => {
    const verdict = evaluateTrialQuality(
      cleanObservation({ poseConfidence: 0.4 as UnitInterval }),
      LIMITS,
      CALIBRATION,
    );
    expect(verdict.kind).toBe('refused');
    if (verdict.kind === 'refused') {
      const [reason] = verdict.reasons;
      expect(reason).toBeDefined();
      expect(reason?.observed).toBe(0.4);
      expect(reason?.limit).toBe(0.8);
      expect(reason?.retryable).toBe(true);
      expect(reason?.userMessage).not.toMatch(/concussion|diagnos|injur|cleared|normal|abnormal/iu);
    }
  });
});

describe('I2 — a measurement is withheld whenever any bound is violated', () => {
  const observation = fc.record({
    cameraMotionDeg: fc.double({ max: 10, min: 0, noDefaultInfinity: true, noNaN: true }),
    faceDistanceCm: fc.double({ max: 150, min: 0, noDefaultInfinity: true, noNaN: true }),
    headRollDeg: fc.double({ max: 90, min: -90, noDefaultInfinity: true, noNaN: true }),
    headYawDeg: fc.double({ max: 90, min: -90, noDefaultInfinity: true, noNaN: true }),
    illumination: fc.double({ max: 1, min: 0, noDefaultInfinity: true, noNaN: true }),
    illuminationUniformity: fc.double({ max: 1, min: 0, noDefaultInfinity: true, noNaN: true }),
    poseConfidence: fc.double({ max: 1, min: 0, noDefaultInfinity: true, noNaN: true }),
    torsoMotionDeg: fc.double({ max: 20, min: 0, noDefaultInfinity: true, noNaN: true }),
    trackedFrameRatio: fc.double({ max: 1, min: 0, noDefaultInfinity: true, noNaN: true }),
    visibleLandmarkRatio: fc.double({ max: 1, min: 0, noDefaultInfinity: true, noNaN: true }),
  }) as fc.Arbitrary<QualityObservation>;

  it('property: acceptance happens if and only if every bound holds — 2000 cases, seed 20260810', () => {
    fc.assert(
      fc.property(observation, (candidate) => {
        const insideEveryBound =
          candidate.faceDistanceCm >= LIMITS.faceDistanceMinCm &&
          candidate.faceDistanceCm <= LIMITS.faceDistanceMaxCm &&
          candidate.illumination >= LIMITS.illuminationMin &&
          candidate.illumination <= LIMITS.illuminationMax &&
          candidate.illuminationUniformity >= LIMITS.illuminationUniformityMin &&
          candidate.visibleLandmarkRatio >= LIMITS.visibleLandmarkRatioMin &&
          Math.abs(candidate.headYawDeg) <= LIMITS.headYawMaxDeg &&
          Math.abs(candidate.headRollDeg) <= LIMITS.headRollMaxDeg &&
          candidate.poseConfidence >= LIMITS.poseConfidenceMin &&
          candidate.cameraMotionDeg <= LIMITS.cameraMotionMaxDeg &&
          candidate.torsoMotionDeg <= LIMITS.torsoMotionMaxDeg &&
          candidate.trackedFrameRatio >= LIMITS.trackedFrameRatioMin;

        const verdict = evaluateTrialQuality(candidate, LIMITS, CALIBRATION);
        expect(verdict.kind === 'accepted').toBe(insideEveryBound);
      }),
      { numRuns: 2000, seed: SEED },
    );
  });

  it('property: a refusal always names at least one reason and never an empty list — 1500 cases, seed 20260810', () => {
    fc.assert(
      fc.property(observation, (candidate) => {
        const verdict = evaluateTrialQuality(candidate, LIMITS, CALIBRATION);
        if (verdict.kind === 'refused') {
          expect(verdict.reasons.length).toBeGreaterThan(0);
          for (const reason of verdict.reasons) {
            expect(reason.observed).not.toBe(reason.limit);
            expect(reason.unit.length).toBeGreaterThan(0);
          }
        }
      }),
      { numRuns: 1500, seed: SEED },
    );
  });
});

describe('I2 — an acceptance cannot be forged', () => {
  it('property: no object shaped like an acceptance is ever authentic — 1000 cases, seed 20260810', () => {
    const genuine = evaluateTrialQuality(cleanObservation(), LIMITS, CALIBRATION);
    expect(genuine.kind).toBe('accepted');

    fc.assert(
      fc.property(
        fc.oneof(
          fc.object(),
          fc.record({
            calibrationDigest: fc.constant(CALIBRATION.referenceDigest),
            checkedKeys: fc.constant([]),
            limitsVersion: fc.constant(QUALITY_LIMITS_VERSION),
            observation: fc.constant(cleanObservation()),
          }),
          fc.constant(null),
          fc.constant(undefined),
          fc.string(),
          fc.integer(),
          fc.array(fc.anything()),
        ),
        (forged) => {
          expect(isAuthenticAcceptance(forged)).toBe(false);
        },
      ),
      { numRuns: 1000, seed: SEED },
    );
  });

  it('rejects a structural clone of a genuine acceptance', () => {
    const verdict = evaluateTrialQuality(cleanObservation(), LIMITS, CALIBRATION);
    expect(verdict.kind).toBe('accepted');
    if (verdict.kind === 'accepted') {
      expect(isAuthenticAcceptance(verdict.acceptance)).toBe(true);
      // Same fields, different identity: the registry is keyed on the object itself.
      expect(isAuthenticAcceptance({ ...verdict.acceptance })).toBe(false);
    }
  });
});
