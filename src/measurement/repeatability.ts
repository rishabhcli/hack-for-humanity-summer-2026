/**
 * Trial statistics and the instrument's own error floor.
 *
 * The three-way error decomposition — constant, absolute, variable — is the standard reporting form
 * in the joint-position-error literature, and reporting all three rather than a single average is
 * what distinguishes a bias from a scatter. Constant error is the signed mean: a participant who
 * consistently overshoots by 4 degrees and one who alternates plus and minus 4 have very different
 * constant errors and identical absolute errors.
 *
 * Everything downstream of this module exists to answer one question honestly: is an observed
 * change larger than this instrument's own noise? That question is unanswerable without the
 * standard error of measurement, so the SEM is computed here and nothing may claim a change without
 * carrying it.
 */

import {
  type DegreesMagnitude,
  type DegreesSigned,
  type PositiveCount,
  parseDegreesMagnitude,
  parsePositiveCount,
} from './units';
import { type TrialMeasured } from './trial-outcome';

/**
 * Fewest measured trials that may produce a repeatability estimate.
 *
 * Below this, the sample standard deviation is dominated by its own sampling error and an MDC
 * derived from it would be a number with no defensible meaning.
 */
export const MINIMUM_REPEATABILITY_TRIALS = 6;

/**
 * Two-sided 95% coverage multiplier for a difference of two independent measurements.
 *
 * `MDC95 = 1.96 * sqrt(2) * SEM`. The `sqrt(2)` is because a change is a difference of two measured
 * values, each carrying the same measurement error.
 */
export const MDC95_Z = 1.96;

export type StatisticsRefusalCode = 'STATISTICS_TOO_FEW_TRIALS' | 'STATISTICS_VALUE_OUT_OF_RANGE';

export type ErrorDecomposition = Readonly<{
  /** Mean unsigned error: how far off, ignoring direction. */
  absoluteError: DegreesMagnitude;
  /** Mean signed error: the systematic bias, positive past neutral. */
  constantError: DegreesSigned;
  trialCount: PositiveCount;
  /** Sample standard deviation of the signed errors: the scatter around that bias. */
  variableError: DegreesMagnitude;
}>;

export type RepeatabilityEstimate = Readonly<{
  decomposition: ErrorDecomposition;
  /**
   * Smallest change that exceeds measurement noise at 95% confidence. A difference smaller than
   * this is not evidence of change, and this instrument reports it as no change in those words.
   */
  minimalDetectableChange: DegreesMagnitude;
  /** Standard error of measurement, estimated as the within-block scatter of repeated trials. */
  standardErrorOfMeasurement: DegreesMagnitude;
}>;

export type StatisticsResult<TValue> =
  | Readonly<{ code: StatisticsRefusalCode; ok: false; trialCount: number }>
  | Readonly<{ ok: true; value: TValue }>;

/** @internal */
function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Sample standard deviation, `n - 1` denominator.
 *
 * The population form would systematically understate the scatter, which would systematically
 * understate the MDC, which would make this instrument claim changes it cannot actually detect.
 * That is the single most dangerous direction for this number to be wrong in.
 *
 * @internal
 */
function sampleStandardDeviation(values: readonly number[]): number {
  const average = mean(values);
  const sumOfSquares = values.reduce((total, value) => total + (value - average) ** 2, 0);
  return Math.sqrt(sumOfSquares / (values.length - 1));
}

/** Decomposes a block of measured trials into constant, absolute, and variable error. */
export function decomposeError(
  trials: readonly TrialMeasured[],
): StatisticsResult<ErrorDecomposition> {
  if (trials.length < MINIMUM_REPEATABILITY_TRIALS) {
    return { code: 'STATISTICS_TOO_FEW_TRIALS', ok: false, trialCount: trials.length };
  }

  const signed = trials.map((trial) => trial.constantError as number);
  const unsigned = trials.map((trial) => trial.absoluteError as number);

  const constantError = parseDegreesSignedClamped(mean(signed));
  const absoluteError = parseDegreesMagnitude(mean(unsigned));
  const variableError = parseDegreesMagnitude(sampleStandardDeviation(signed));
  const trialCount = parsePositiveCount(trials.length);

  if (!constantError.ok || !absoluteError.ok || !variableError.ok || !trialCount.ok) {
    return { code: 'STATISTICS_VALUE_OUT_OF_RANGE', ok: false, trialCount: trials.length };
  }

  return {
    ok: true,
    value: {
      absoluteError: absoluteError.value,
      constantError: constantError.value,
      trialCount: trialCount.value,
      variableError: variableError.value,
    },
  };
}

/**
 * Estimates this session's own measurement error from its repeated trials.
 *
 * The SEM is estimated as the within-block scatter of repeated trials of the same condition. This
 * is the single-session estimator: it treats every trial as a repeat of one measurement, so it
 * captures trial-to-trial noise but *not* between-day variation in the neutral reference itself.
 * The report states that limitation where the number is shown; see `docs/INVARIANTS.md`.
 */
export function estimateRepeatability(
  trials: readonly TrialMeasured[],
): StatisticsResult<RepeatabilityEstimate> {
  const decomposition = decomposeError(trials);
  if (!decomposition.ok) {
    return decomposition;
  }

  const standardErrorOfMeasurement = decomposition.value.variableError;
  const minimalDetectableChange = parseDegreesMagnitude(
    MDC95_Z * Math.SQRT2 * standardErrorOfMeasurement,
  );
  if (!minimalDetectableChange.ok) {
    return { code: 'STATISTICS_VALUE_OUT_OF_RANGE', ok: false, trialCount: trials.length };
  }

  return {
    ok: true,
    value: {
      decomposition: decomposition.value,
      minimalDetectableChange: minimalDetectableChange.value,
      standardErrorOfMeasurement,
    },
  };
}

/**
 * Parses a mean signed error, normalizing the one representable value outside the signed range.
 *
 * A mean of values in `(-180, 180]` can only reach exactly `-180` when every value is `-180`, which
 * denotes the same displacement as `+180`.
 *
 * @internal
 */
function parseDegreesSignedClamped(
  value: number,
): { ok: false } | Readonly<{ ok: true; value: DegreesSigned }> {
  if (!Number.isFinite(value)) {
    return { ok: false };
  }
  const normalized = value === -180 ? 180 : value;
  if (normalized <= -180 || normalized > 180) {
    return { ok: false };
  }
  return { ok: true, value: normalized as DegreesSigned };
}
