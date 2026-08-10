/**
 * Change claims.
 *
 * Domain invariant I3 — "improvement is reported only relative to declared measurement error" — is
 * encoded here by making the alternative unrepresentable. There is no type in this module that
 * carries an observed change without also carrying the minimal detectable change it was judged
 * against, and the only arm that says a change happened can only be produced by
 * {@link compareBlocks}, which requires a {@link RepeatabilityEstimate} for each block.
 *
 * The refusal arm matters as much as the verdict arms. Two blocks measured against different
 * neutral references, or against different calibration algorithms, are not comparable, and this
 * module says so rather than normalizing the difference away.
 */

import {
  type CalibrationRecord,
  type SessionId,
  calibrationsAreComparable,
  sameCalibration,
} from '../protocol/calibration';
import { type RepeatabilityEstimate } from './repeatability';
import {
  type DegreesMagnitude,
  type DegreesSigned,
  differenceOf,
  magnitudeOf,
  parseDegreesMagnitude,
} from './units';

/** Which measurement block a summary came from within the pre/train/post protocol. */
export type BlockLabel = 'baseline' | 'retest';

export type MeasurementBlock = Readonly<{
  calibration: CalibrationRecord;
  label: BlockLabel;
  repeatability: RepeatabilityEstimate;
}>;

export type ChangeRefusalCode =
  | 'CHANGE_REFUSED_BLOCK_ORDER_INVALID'
  | 'CHANGE_REFUSED_CALIBRATION_VERSION_MISMATCH'
  | 'CHANGE_REFUSED_DIFFERENT_NEUTRAL_REFERENCE'
  | 'CHANGE_REFUSED_UNCERTAINTY_UNAVAILABLE';

/**
 * Judgement about whether a repositioning error moved.
 *
 * Every arm carries `minimalDetectableChange`. That is the whole point: there is no shape in this
 * union that reports a change without the noise floor it was compared against, so no consumer can
 * render one without the other.
 */
export type ChangeVerdict =
  | Readonly<{
      /** Difference in mean absolute error, retest minus baseline. Negative means less error. */
      observedChange: DegreesSigned;
      kind: 'within-measurement-error';
      minimalDetectableChange: DegreesMagnitude;
      /** Deliberately plain wording. "No change" is the finding, not a hedge. */
      statement: 'Inside this session’s measurement error — not a change.';
    }>
  | Readonly<{
      /** Whether the retest error was lower (less repositioning error) or higher. */
      direction: 'higher' | 'lower';
      observedChange: DegreesSigned;
      kind: 'exceeds-measurement-error';
      minimalDetectableChange: DegreesMagnitude;
      statement: 'Larger than this session’s measurement error.';
    }>
  | Readonly<{ code: ChangeRefusalCode; kind: 'refused'; statement: string }>;

/**
 * The combined noise floor of a difference between two blocks.
 *
 * Each block carries its own measurement error, and a difference carries both. Using only one
 * block's MDC would understate the floor and make this instrument claim changes it cannot detect,
 * so the two are combined in quadrature.
 */
export function combinedMinimalDetectableChange(
  baseline: RepeatabilityEstimate,
  retest: RepeatabilityEstimate,
): DegreesMagnitude | null {
  const combined = Math.sqrt(
    baseline.minimalDetectableChange ** 2 + retest.minimalDetectableChange ** 2,
  );
  const parsed = parseDegreesMagnitude(combined);
  return parsed.ok ? parsed.value : null;
}

/** @internal */
function refuse(code: ChangeRefusalCode, statement: string): ChangeVerdict {
  return { code, kind: 'refused', statement };
}

/**
 * Compares a baseline block against a retest block.
 *
 * Refuses rather than normalizes whenever the two are not the same measurement: a different
 * calibration algorithm, a different neutral reference, or blocks supplied in the wrong roles.
 */
export function compareBlocks(baseline: MeasurementBlock, retest: MeasurementBlock): ChangeVerdict {
  if (baseline.label !== 'baseline' || retest.label !== 'retest') {
    return refuse(
      'CHANGE_REFUSED_BLOCK_ORDER_INVALID',
      'These two sets of trials are not a baseline and a retest, so no change can be reported.',
    );
  }

  if (!calibrationsAreComparable(baseline.calibration, retest.calibration)) {
    return refuse(
      'CHANGE_REFUSED_CALIBRATION_VERSION_MISMATCH',
      'These measurements were taken by different versions of the calibration, so they cannot be compared.',
    );
  }

  if (!sameCalibration(baseline.calibration, retest.calibration)) {
    return refuse(
      'CHANGE_REFUSED_DIFFERENT_NEUTRAL_REFERENCE',
      'These measurements used different neutral references, so a change between them cannot be separated from the reference itself.',
    );
  }

  const minimalDetectableChange = combinedMinimalDetectableChange(
    baseline.repeatability,
    retest.repeatability,
  );
  if (minimalDetectableChange === null) {
    return refuse(
      'CHANGE_REFUSED_UNCERTAINTY_UNAVAILABLE',
      'This session’s measurement error could not be established, so no change can be reported.',
    );
  }

  const observedChange = differenceOf(
    retest.repeatability.decomposition.absoluteError,
    baseline.repeatability.decomposition.absoluteError,
  );

  if (magnitudeOf(observedChange) <= minimalDetectableChange) {
    return {
      kind: 'within-measurement-error',
      minimalDetectableChange,
      observedChange,
      statement: 'Inside this session’s measurement error — not a change.',
    };
  }

  return {
    direction: observedChange < 0 ? 'lower' : 'higher',
    kind: 'exceeds-measurement-error',
    minimalDetectableChange,
    observedChange,
    statement: 'Larger than this session’s measurement error.',
  };
}

/** True only when a verdict asserts that something actually moved. */
export function assertsChange(verdict: ChangeVerdict): boolean {
  return verdict.kind === 'exceeds-measurement-error';
}

/** The session a verdict belongs to, for report and export provenance. */
export function sessionOf(block: MeasurementBlock): SessionId {
  return block.calibration.sessionId;
}
