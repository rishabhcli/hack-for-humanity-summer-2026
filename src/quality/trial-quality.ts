/**
 * Trial quality gating.
 *
 * Domain invariant I2 — "a measurement is withheld when geometry or pose confidence fails" — is
 * encoded here, and it is encoded as a *capability*, not as a check that callers are trusted to
 * remember to run.
 *
 * {@link evaluateTrialQuality} is the only function in the repository that can mint a
 * {@link QualityAcceptance}. The measurement package requires one in order to produce a measured
 * outcome, so there is no code path that yields a number without having passed this gate. The
 * acceptance is unforgeable twice over: its brand is a module-private `unique symbol`, so no other
 * module can name the type, and every minted value is registered in a module-private `WeakSet`, so
 * an object cast into the type with `as` is rejected by {@link isAuthenticAcceptance} at the
 * measurement boundary.
 *
 * Every check produces a distinct refusal reason. A trial is never partially accepted, and a
 * low-confidence value is never reported with a caveat instead of being withheld.
 */

import {
  type Centimetres,
  type DegreesMagnitude,
  type DegreesSigned,
  type UnitInterval,
  magnitudeOf,
} from '../measurement/units';
import { type CalibrationRecord } from '../protocol/calibration';

/**
 * Module-private brand. Not exported, so no other module can write this key in an object literal.
 *
 * Object spread copies own symbol properties, so a structural clone of an acceptance does carry
 * this key — which is precisely why the runtime registry below, not the brand, is the authority.
 */
const qualityAcceptanceBrand = Symbol('quality-acceptance');

export const QUALITY_LIMITS_VERSION = 1;

export type QualityCheckKey =
  | 'camera-motion'
  | 'face-distance'
  | 'illumination'
  | 'landmark-occlusion'
  | 'head-roll-limit'
  | 'head-yaw-limit'
  | 'pose-confidence'
  | 'torso-motion'
  | 'tracking-continuity';

export type QualityRefusalCode =
  | 'QUALITY_CAMERA_MOTION_DETECTED'
  | 'QUALITY_FACE_TOO_FAR'
  | 'QUALITY_FACE_TOO_NEAR'
  | 'QUALITY_HEAD_ROLL_OUT_OF_RANGE'
  | 'QUALITY_HEAD_YAW_OUT_OF_RANGE'
  | 'QUALITY_ILLUMINATION_TOO_HIGH'
  | 'QUALITY_ILLUMINATION_TOO_LOW'
  | 'QUALITY_ILLUMINATION_UNEVEN'
  | 'QUALITY_LANDMARKS_OCCLUDED'
  | 'QUALITY_POSE_CONFIDENCE_LOW'
  | 'QUALITY_TORSO_MOTION_NOT_SEPARABLE'
  | 'QUALITY_TRACKING_DISCONTINUOUS';

/**
 * The engineering envelope this instrument is supported inside.
 *
 * These are *not* clinical thresholds and carry no citation requirement: they describe where the
 * landmark pipeline has been characterized, and they belong to `SUPPORT_MATRIX.md`. Clinical
 * numbers live in the citation-gated registry instead, under invariant I7.
 */
export type QualityLimits = Readonly<{
  cameraMotionMaxDeg: DegreesMagnitude;
  faceDistanceMaxCm: Centimetres;
  faceDistanceMinCm: Centimetres;
  headRollMaxDeg: DegreesMagnitude;
  headYawMaxDeg: DegreesMagnitude;
  illuminationMax: UnitInterval;
  illuminationMin: UnitInterval;
  illuminationUniformityMin: UnitInterval;
  poseConfidenceMin: UnitInterval;
  torsoMotionMaxDeg: DegreesMagnitude;
  trackedFrameRatioMin: UnitInterval;
  version: typeof QUALITY_LIMITS_VERSION;
  visibleLandmarkRatioMin: UnitInterval;
}>;

/**
 * Signals observed over the endpoint window of one trial — the window whose average becomes the
 * measurement. Gating the endpoint window is what matters: a trial can pass through poor geometry
 * mid-rotation and still produce a sound endpoint, and it can look fine mid-rotation and be
 * unusable where it is actually read.
 */
export type QualityObservation = Readonly<{
  /** Angular motion attributed to the camera itself over the endpoint window. */
  cameraMotionDeg: DegreesMagnitude;
  faceDistanceCm: Centimetres;
  headRollDeg: DegreesSigned;
  headYawDeg: DegreesSigned;
  illumination: UnitInterval;
  illuminationUniformity: UnitInterval;
  poseConfidence: UnitInterval;
  /** Angular motion attributed to the torso rather than to the cervical spine. */
  torsoMotionDeg: DegreesMagnitude;
  /** Fraction of frames in the endpoint window with a usable landmark solution. */
  trackedFrameRatio: UnitInterval;
  visibleLandmarkRatio: UnitInterval;
}>;

export type QualityRefusal = Readonly<{
  check: QualityCheckKey;
  code: QualityRefusalCode;
  /** Value observed, in the unit named by {@link QualityRefusal.unit}. */
  observed: number;
  /** Bound that was violated, in the same unit. */
  limit: number;
  /** Quality refusals are always retryable: the participant can retake the trial. */
  retryable: true;
  unit: string;
  /** Safe for display. Describes the environment, never the person and never a finding. */
  userMessage: string;
}>;

/**
 * Proof that one trial's endpoint window passed every quality check.
 *
 * Obtainable only from {@link evaluateTrialQuality}.
 */
export type QualityAcceptance = Readonly<{
  readonly [qualityAcceptanceBrand]: true;
  /** Calibration the trial was measured against, so the acceptance cannot be reused elsewhere. */
  calibrationDigest: string;
  checkedKeys: readonly QualityCheckKey[];
  limitsVersion: typeof QUALITY_LIMITS_VERSION;
  observation: QualityObservation;
}>;

export type QualityVerdict =
  | Readonly<{ acceptance: QualityAcceptance; kind: 'accepted' }>
  | Readonly<{ kind: 'refused'; reasons: readonly QualityRefusal[] }>;

/**
 * Registry of acceptances this module actually minted.
 *
 * A `WeakSet` keyed on identity means a forged object — however well shaped, however cast — is not
 * present here, so the measurement boundary can reject it at runtime rather than trusting that no
 * one wrote `as QualityAcceptance`.
 */
const mintedAcceptances = new WeakSet<object>();

export function isAuthenticAcceptance(candidate: unknown): candidate is QualityAcceptance {
  return typeof candidate === 'object' && candidate !== null && mintedAcceptances.has(candidate);
}

const ALL_CHECK_KEYS: readonly QualityCheckKey[] = [
  'camera-motion',
  'face-distance',
  'head-roll-limit',
  'head-yaw-limit',
  'illumination',
  'landmark-occlusion',
  'pose-confidence',
  'torso-motion',
  'tracking-continuity',
];

/** @internal */
function refuse(
  check: QualityCheckKey,
  code: QualityRefusalCode,
  observed: number,
  limit: number,
  unit: string,
  userMessage: string,
): QualityRefusal {
  return { check, code, limit, observed, retryable: true, unit, userMessage };
}

/**
 * Evaluates one trial's endpoint window against the supported envelope.
 *
 * Returns every violated check rather than the first, so a participant is told about all of the
 * conditions to correct instead of discovering them one retake at a time.
 */
export function evaluateTrialQuality(
  observation: QualityObservation,
  limits: QualityLimits,
  calibration: CalibrationRecord,
): QualityVerdict {
  const reasons: QualityRefusal[] = [];

  if (observation.faceDistanceCm < limits.faceDistanceMinCm) {
    reasons.push(
      refuse(
        'face-distance',
        'QUALITY_FACE_TOO_NEAR',
        observation.faceDistanceCm,
        limits.faceDistanceMinCm,
        'cm',
        'Move back from the camera until your whole head is comfortably in frame.',
      ),
    );
  } else if (observation.faceDistanceCm > limits.faceDistanceMaxCm) {
    reasons.push(
      refuse(
        'face-distance',
        'QUALITY_FACE_TOO_FAR',
        observation.faceDistanceCm,
        limits.faceDistanceMaxCm,
        'cm',
        'Move closer to the camera so the landmarks can be resolved.',
      ),
    );
  }

  if (observation.illumination < limits.illuminationMin) {
    reasons.push(
      refuse(
        'illumination',
        'QUALITY_ILLUMINATION_TOO_LOW',
        observation.illumination,
        limits.illuminationMin,
        'normalized',
        'Add light in front of you. The scene is too dark to track reliably.',
      ),
    );
  } else if (observation.illumination > limits.illuminationMax) {
    reasons.push(
      refuse(
        'illumination',
        'QUALITY_ILLUMINATION_TOO_HIGH',
        observation.illumination,
        limits.illuminationMax,
        'normalized',
        'Reduce the light or move away from the bright source behind you.',
      ),
    );
  }

  if (observation.illuminationUniformity < limits.illuminationUniformityMin) {
    reasons.push(
      refuse(
        'illumination',
        'QUALITY_ILLUMINATION_UNEVEN',
        observation.illuminationUniformity,
        limits.illuminationUniformityMin,
        'normalized',
        'Even out the lighting. One side of your face is much brighter than the other.',
      ),
    );
  }

  if (observation.visibleLandmarkRatio < limits.visibleLandmarkRatioMin) {
    reasons.push(
      refuse(
        'landmark-occlusion',
        'QUALITY_LANDMARKS_OCCLUDED',
        observation.visibleLandmarkRatio,
        limits.visibleLandmarkRatioMin,
        'ratio',
        'Part of your face was hidden. Clear hair, hands, or frames from the view.',
      ),
    );
  }

  const yawMagnitude = magnitudeOf(observation.headYawDeg);
  if (yawMagnitude > limits.headYawMaxDeg) {
    reasons.push(
      refuse(
        'head-yaw-limit',
        'QUALITY_HEAD_YAW_OUT_OF_RANGE',
        yawMagnitude,
        limits.headYawMaxDeg,
        'deg',
        'Your head finished outside the range this instrument is validated for.',
      ),
    );
  }

  const rollMagnitude = magnitudeOf(observation.headRollDeg);
  if (rollMagnitude > limits.headRollMaxDeg) {
    reasons.push(
      refuse(
        'head-roll-limit',
        'QUALITY_HEAD_ROLL_OUT_OF_RANGE',
        rollMagnitude,
        limits.headRollMaxDeg,
        'deg',
        'Your head was tilted too far to one side for this measurement.',
      ),
    );
  }

  if (observation.poseConfidence < limits.poseConfidenceMin) {
    reasons.push(
      refuse(
        'pose-confidence',
        'QUALITY_POSE_CONFIDENCE_LOW',
        observation.poseConfidence,
        limits.poseConfidenceMin,
        'confidence',
        'The head position could not be resolved confidently enough to report.',
      ),
    );
  }

  if (observation.cameraMotionDeg > limits.cameraMotionMaxDeg) {
    reasons.push(
      refuse(
        'camera-motion',
        'QUALITY_CAMERA_MOTION_DETECTED',
        observation.cameraMotionDeg,
        limits.cameraMotionMaxDeg,
        'deg',
        'The camera moved during the trial. Put the device on a stable surface.',
      ),
    );
  }

  if (observation.torsoMotionDeg > limits.torsoMotionMaxDeg) {
    reasons.push(
      refuse(
        'torso-motion',
        'QUALITY_TORSO_MOTION_NOT_SEPARABLE',
        observation.torsoMotionDeg,
        limits.torsoMotionMaxDeg,
        'deg',
        'Your shoulders turned with your head, so the neck movement could not be separated.',
      ),
    );
  }

  if (observation.trackedFrameRatio < limits.trackedFrameRatioMin) {
    reasons.push(
      refuse(
        'tracking-continuity',
        'QUALITY_TRACKING_DISCONTINUOUS',
        observation.trackedFrameRatio,
        limits.trackedFrameRatioMin,
        'ratio',
        'Tracking dropped out during the trial. Retake it.',
      ),
    );
  }

  if (reasons.length > 0) {
    return { kind: 'refused', reasons };
  }

  const acceptance: QualityAcceptance = {
    [qualityAcceptanceBrand]: true,
    calibrationDigest: calibration.referenceDigest,
    checkedKeys: ALL_CHECK_KEYS,
    limitsVersion: QUALITY_LIMITS_VERSION,
    observation,
  };
  mintedAcceptances.add(acceptance);
  return { acceptance, kind: 'accepted' };
}
