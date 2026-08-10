/**
 * The outcome of a single repositioning trial.
 *
 * This module is where domain invariant I2 stops being a rule someone has to remember and becomes
 * a shape the type system will not let you avoid. A {@link TrialOutcome} is a tagged union with
 * exactly two arms, and the `measured` arm cannot be constructed without a
 * {@link QualityAcceptance} minted by the quality gate. There is no third arm for "measured but
 * low confidence", because a low-confidence number displayed with a caveat is the failure this
 * instrument exists to avoid.
 *
 * The acceptance is checked again at runtime here, not just at compile time. A caller who casts an
 * object into `QualityAcceptance` with `as` still gets a withheld outcome, because the acceptance
 * must be one the quality gate actually minted.
 */

import { type CalibrationRecord, type SessionId } from '../protocol/calibration';
import {
  type QualityAcceptance,
  type QualityRefusal,
  isAuthenticAcceptance,
} from '../quality/trial-quality';
import {
  type DegreesMagnitude,
  type DegreesSigned,
  type PositiveCount,
  type UnitInterval,
  magnitudeOf,
} from './units';

/** Direction the participant was cued to rotate toward before returning to neutral. */
export type RotationDirection = 'down' | 'left' | 'right' | 'up';

export type WithheldReasonCode =
  | 'TRIAL_ACCEPTANCE_NOT_AUTHENTIC'
  | 'TRIAL_ACCEPTANCE_WRONG_CALIBRATION'
  | 'TRIAL_ENDPOINT_NOT_STATIONARY'
  | 'TRIAL_QUALITY_REFUSED'
  | 'TRIAL_SAMPLE_COUNT_INSUFFICIENT';

/** Fewest endpoint-window frames whose average may be reported as an endpoint. */
export const MINIMUM_ENDPOINT_SAMPLES = 15;

export type TrialWithheld = Readonly<{
  code: WithheldReasonCode;
  direction: RotationDirection;
  kind: 'withheld';
  /** Present only when the quality gate itself refused; empty for structural refusals. */
  qualityReasons: readonly QualityRefusal[];
  sessionId: SessionId;
  /** Safe for display, non-diagnostic, and never a number. */
  userMessage: string;
}>;

export type TrialMeasured = Readonly<{
  /** Unsigned angular distance between the endpoint pose and the neutral reference. */
  absoluteError: DegreesMagnitude;
  /** Proof the endpoint window passed every quality check. */
  acceptance: QualityAcceptance;
  /** Signed error: positive is past neutral in the rotation direction, negative is short of it. */
  constantError: DegreesSigned;
  direction: RotationDirection;
  /** Frames averaged to produce the endpoint, which sets the `1/sqrt(n)` noise reduction. */
  endpointSamples: PositiveCount;
  kind: 'measured';
  /** Calibration this error was computed against. Carried so it can never be inferred later. */
  referenceDigest: string;
  sessionId: SessionId;
  /** Within-window angular dispersion of the endpoint, normalized to the session's own jitter. */
  stationarity: UnitInterval;
}>;

export type TrialOutcome = TrialMeasured | TrialWithheld;

export type TrialInput = Readonly<{
  acceptance: QualityAcceptance;
  calibration: CalibrationRecord;
  /** Signed angular displacement of the endpoint pose from the neutral reference. */
  constantError: DegreesSigned;
  direction: RotationDirection;
  endpointSamples: PositiveCount;
  stationarity: UnitInterval;
}>;

/** @internal */
function withhold(
  code: WithheldReasonCode,
  direction: RotationDirection,
  sessionId: SessionId,
  userMessage: string,
  qualityReasons: readonly QualityRefusal[] = [],
): TrialWithheld {
  return { code, direction, kind: 'withheld', qualityReasons, sessionId, userMessage };
}

/**
 * Produces a withheld outcome for a trial the quality gate refused.
 *
 * Callers cannot reach {@link recordTrial} in this case, because they have no acceptance to pass.
 */
export function withholdForQuality(
  direction: RotationDirection,
  calibration: CalibrationRecord,
  reasons: readonly QualityRefusal[],
): TrialWithheld {
  return withhold(
    'TRIAL_QUALITY_REFUSED',
    direction,
    calibration.sessionId,
    'This attempt was not measured. Correct the conditions listed and take it again.',
    reasons,
  );
}

/**
 * The only constructor of a measured trial outcome.
 *
 * Every path that would produce a number without a genuine, correctly-scoped acceptance and a
 * sufficient, stationary endpoint window returns a withheld outcome instead.
 */
export function recordTrial(input: TrialInput): TrialOutcome {
  const { calibration, direction } = input;

  if (!isAuthenticAcceptance(input.acceptance)) {
    return withhold(
      'TRIAL_ACCEPTANCE_NOT_AUTHENTIC',
      direction,
      calibration.sessionId,
      'This attempt was not measured because its quality check could not be verified.',
    );
  }

  // An acceptance is scoped to the neutral reference it was evaluated against. Reusing one from a
  // different calibration would silently measure against the wrong reference geometry.
  if (input.acceptance.calibrationDigest !== calibration.referenceDigest) {
    return withhold(
      'TRIAL_ACCEPTANCE_WRONG_CALIBRATION',
      direction,
      calibration.sessionId,
      'This attempt was not measured because it did not match the current calibration.',
    );
  }

  if (input.endpointSamples < MINIMUM_ENDPOINT_SAMPLES) {
    return withhold(
      'TRIAL_SAMPLE_COUNT_INSUFFICIENT',
      direction,
      calibration.sessionId,
      'This attempt was not measured because too few frames were usable at the endpoint.',
    );
  }

  // The endpoint average is only meaningful over a window the head actually held still in. The
  // threshold is the session's own measured jitter, never a fixed velocity cutoff.
  if (input.stationarity > calibration.stability) {
    return withhold(
      'TRIAL_ENDPOINT_NOT_STATIONARY',
      direction,
      calibration.sessionId,
      'This attempt was not measured because your head was still moving when it was read.',
    );
  }

  return {
    absoluteError: magnitudeOf(input.constantError),
    acceptance: input.acceptance,
    constantError: input.constantError,
    direction,
    endpointSamples: input.endpointSamples,
    kind: 'measured',
    referenceDigest: calibration.referenceDigest,
    sessionId: calibration.sessionId,
    stationarity: input.stationarity,
  };
}

/** True only for outcomes that carry a reportable number. */
export function isMeasured(outcome: TrialOutcome): outcome is TrialMeasured {
  return outcome.kind === 'measured';
}

/**
 * Selects the trials of a session that may contribute to a summary statistic.
 *
 * Withheld trials are dropped rather than imputed, and a trial measured against a different
 * calibration is dropped rather than pooled, because pooling across references is exactly the
 * silent normalization invariant I4 forbids.
 */
export function measuredTrialsFor(
  calibration: CalibrationRecord,
  outcomes: readonly TrialOutcome[],
): readonly TrialMeasured[] {
  return outcomes.filter(
    (outcome): outcome is TrialMeasured =>
      isMeasured(outcome) && outcome.referenceDigest === calibration.referenceDigest,
  );
}
