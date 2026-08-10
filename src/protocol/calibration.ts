/**
 * Session calibration identity.
 *
 * Domain invariant I4 — "neutral reference and calibration are versioned per session" — is encoded
 * here. A neutral reference is not a loose set of numbers that measurement code may reach for: it
 * is a {@link CalibrationRecord} carrying the algorithm version that produced it, the session it
 * belongs to, and a digest of the reference geometry itself. Every downstream measurement carries
 * that identity, so a measurement can always name the calibration it was taken under, and two
 * measurements produced by different calibration algorithms are detected rather than pooled.
 *
 * The version is deliberately a plain number on the record rather than the current literal. A
 * record restored from a session captured by an earlier build genuinely carries an earlier
 * version, and the whole point of I4 is that such a record is comparable to nothing but its own
 * generation. Modelling the field as the current literal would make that comparison vacuously true.
 */

import {
  type Milliseconds,
  type ParseResult,
  type PositiveCount,
  type UnitInterval,
  parseMilliseconds,
  parsePositiveCount,
  parseUnitInterval,
} from '../measurement/units';

/**
 * Version of the calibration *algorithm*, not of a particular capture.
 *
 * Bump this whenever neutral-reference construction changes in a way that makes two references
 * incomparable — a different landmark subset, a different robust average, a different alignment.
 * Comparing measurements across two different values is refused, never normalized.
 */
export const CALIBRATION_ALGORITHM_VERSION = 1;

/**
 * Versions whose stored records this build can still read.
 *
 * Reading an old record is allowed; comparing across versions is not. Removing a version from this
 * list is a breaking change to stored sessions and needs its own ADR.
 */
export const READABLE_CALIBRATION_ALGORITHM_VERSIONS: readonly number[] = [1];

declare const sessionIdBrand: unique symbol;

/** Opaque per-session identifier. Never derived from anything about the person. */
export type SessionId = string & { readonly [sessionIdBrand]: 'session-id' };

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const REFERENCE_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

/** Shortest neutral hold that may produce a reference, in milliseconds. */
export const MINIMUM_NEUTRAL_HOLD_MS = 3_000;

/** Fewest accepted frames that may produce a reference. */
export const MINIMUM_REFERENCE_SAMPLES = 30;

export type CalibrationViolationCode =
  | 'CALIBRATION_ALGORITHM_VERSION_UNREADABLE'
  | 'CALIBRATION_ALGORITHM_VERSION_UNSUPPORTED'
  | 'CALIBRATION_HOLD_TOO_SHORT'
  | 'CALIBRATION_REFERENCE_DIGEST_INVALID'
  | 'CALIBRATION_SAMPLE_COUNT_INVALID'
  | 'CALIBRATION_SESSION_ID_INVALID'
  | 'CALIBRATION_STABILITY_INVALID';

/**
 * A neutral reference that measurement is permitted to use.
 *
 * The only constructors are {@link buildCalibrationRecord}, for a fresh capture, and
 * {@link restoreCalibrationRecord}, for a stored one. Both refuse every input that would produce a
 * reference too weak to measure against.
 */
export type CalibrationRecord = Readonly<{
  /** Frames that survived quality gating and contributed to the reference. */
  acceptedSamples: PositiveCount;
  algorithmVersion: number;
  /** Duration of the neutral hold the reference was averaged over. */
  holdDuration: Milliseconds;
  /** Digest of the reference geometry; identifies the reference without carrying any imagery. */
  referenceDigest: string;
  sessionId: SessionId;
  /**
   * Angular jitter observed during the neutral hold, normalized to `[0, 1]` against the session's
   * own stationarity envelope. This is the session's own noise floor, and every later stationarity
   * decision is derived from it rather than from a fixed threshold.
   */
  stability: UnitInterval;
}>;

export type CalibrationFailure = Readonly<{ code: CalibrationViolationCode; ok: false }>;

export type CalibrationResult =
  CalibrationFailure | Readonly<{ ok: true; value: CalibrationRecord }>;

export type CalibrationDraft = Readonly<{
  acceptedSamples: unknown;
  algorithmVersion: unknown;
  holdDurationMs: unknown;
  referenceDigest: unknown;
  sessionId: unknown;
  stability: unknown;
}>;

export function parseSessionId(candidate: unknown): ParseResult<SessionId> {
  if (typeof candidate !== 'string' || !SESSION_ID_PATTERN.test(candidate)) {
    return { code: 'UNIT_NOT_A_NUMBER', ok: false, unit: 'session-id' };
  }
  return { ok: true, value: candidate as SessionId };
}

/** @internal Validates every field except the algorithm version, whose policy differs by entry point. */
function validateDraftBody(draft: CalibrationDraft, algorithmVersion: number): CalibrationResult {
  const sessionId = parseSessionId(draft.sessionId);
  if (!sessionId.ok) {
    return { code: 'CALIBRATION_SESSION_ID_INVALID', ok: false };
  }

  if (
    typeof draft.referenceDigest !== 'string' ||
    !REFERENCE_DIGEST_PATTERN.test(draft.referenceDigest)
  ) {
    return { code: 'CALIBRATION_REFERENCE_DIGEST_INVALID', ok: false };
  }

  const acceptedSamples = parsePositiveCount(draft.acceptedSamples);
  if (!acceptedSamples.ok || acceptedSamples.value < MINIMUM_REFERENCE_SAMPLES) {
    return { code: 'CALIBRATION_SAMPLE_COUNT_INVALID', ok: false };
  }

  const holdDuration = parseMilliseconds(draft.holdDurationMs);
  if (!holdDuration.ok || holdDuration.value < MINIMUM_NEUTRAL_HOLD_MS) {
    return { code: 'CALIBRATION_HOLD_TOO_SHORT', ok: false };
  }

  const stability = parseUnitInterval(draft.stability);
  if (!stability.ok) {
    return { code: 'CALIBRATION_STABILITY_INVALID', ok: false };
  }

  return {
    ok: true,
    value: {
      acceptedSamples: acceptedSamples.value,
      algorithmVersion,
      holdDuration: holdDuration.value,
      referenceDigest: draft.referenceDigest,
      sessionId: sessionId.value,
      stability: stability.value,
    },
  };
}

/**
 * Validates a freshly captured calibration.
 *
 * A new capture must be produced by the current algorithm: accepting an older version here would
 * mean this build claiming to have produced a reference it cannot produce.
 */
export function buildCalibrationRecord(draft: CalibrationDraft): CalibrationResult {
  if (draft.algorithmVersion !== CALIBRATION_ALGORITHM_VERSION) {
    return { code: 'CALIBRATION_ALGORITHM_VERSION_UNSUPPORTED', ok: false };
  }
  return validateDraftBody(draft, CALIBRATION_ALGORITHM_VERSION);
}

/**
 * Validates a calibration restored from stored session state.
 *
 * The stored version is preserved rather than upgraded, so a record captured by an earlier build
 * stays honestly labelled and {@link calibrationsAreComparable} can refuse to compare across it.
 */
export function restoreCalibrationRecord(draft: CalibrationDraft): CalibrationResult {
  const version = draft.algorithmVersion;
  if (
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    !READABLE_CALIBRATION_ALGORITHM_VERSIONS.includes(version)
  ) {
    return { code: 'CALIBRATION_ALGORITHM_VERSION_UNREADABLE', ok: false };
  }
  return validateDraftBody(draft, version);
}

/** Two calibrations are comparable only when the same algorithm produced both references. */
export function calibrationsAreComparable(
  left: CalibrationRecord,
  right: CalibrationRecord,
): boolean {
  return left.algorithmVersion === right.algorithmVersion;
}

/** Two measurements belong to the same calibration only when every identity field agrees. */
export function sameCalibration(left: CalibrationRecord, right: CalibrationRecord): boolean {
  return (
    calibrationsAreComparable(left, right) &&
    left.sessionId === right.sessionId &&
    left.referenceDigest === right.referenceDigest
  );
}
