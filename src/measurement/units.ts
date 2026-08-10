/**
 * Branded scalar units.
 *
 * A bare `number` never crosses a boundary in the domain packages of this repository. The unit is
 * part of the type, so degrees cannot be passed where milliseconds or a probability are expected,
 * and a value that has not been range-checked cannot be passed at all: the only way to obtain a
 * branded value is to parse one.
 */

declare const unitBrand: unique symbol;

type Branded<TUnit extends string> = number & { readonly [unitBrand]: TUnit };

/** Non-negative angular magnitude in degrees, `0 <= value <= 180`. */
export type DegreesMagnitude = Branded<'degrees-magnitude'>;

/** Signed angular displacement in degrees, `-180 < value <= 180`. */
export type DegreesSigned = Branded<'degrees-signed'>;

/** Non-negative duration in milliseconds. */
export type Milliseconds = Branded<'milliseconds'>;

/** Probability or normalized confidence, `0 <= value <= 1`. */
export type UnitInterval = Branded<'unit-interval'>;

/** Non-negative distance in centimetres. */
export type Centimetres = Branded<'centimetres'>;

/** Count of discrete items, `value >= 1` and integral. */
export type PositiveCount = Branded<'positive-count'>;

export const DEGREES_MAGNITUDE_MAX = 180;
export const DEGREES_SIGNED_MIN_EXCLUSIVE = -180;
export const DEGREES_SIGNED_MAX = 180;

export type UnitViolationCode =
  'UNIT_NOT_A_NUMBER' | 'UNIT_NOT_FINITE' | 'UNIT_NOT_INTEGER' | 'UNIT_OUT_OF_RANGE';

export type ParseFailure = Readonly<{
  code: UnitViolationCode;
  ok: false;
  /** Safe for logs and user-facing detail: a description, never the raw untrusted value. */
  unit: string;
}>;

export type ParseSuccess<TValue> = Readonly<{ ok: true; value: TValue }>;

export type ParseResult<TValue> = ParseFailure | ParseSuccess<TValue>;

/** @internal */
function failure(code: UnitViolationCode, unit: string): ParseFailure {
  return { code, ok: false, unit };
}

/** @internal */
function parseBounded<TValue extends number>(
  candidate: unknown,
  unit: string,
  isInRange: (value: number) => boolean,
  requireInteger: boolean,
): ParseResult<TValue> {
  if (typeof candidate !== 'number') {
    return failure('UNIT_NOT_A_NUMBER', unit);
  }
  if (!Number.isFinite(candidate)) {
    return failure('UNIT_NOT_FINITE', unit);
  }
  if (requireInteger && !Number.isInteger(candidate)) {
    return failure('UNIT_NOT_INTEGER', unit);
  }
  if (!isInRange(candidate)) {
    return failure('UNIT_OUT_OF_RANGE', unit);
  }
  // `Object.is` normalizes -0 to 0 so two equal magnitudes serialize identically.
  return { ok: true, value: (candidate === 0 ? 0 : candidate) as TValue };
}

export function parseDegreesMagnitude(candidate: unknown): ParseResult<DegreesMagnitude> {
  return parseBounded<DegreesMagnitude>(
    candidate,
    'degrees-magnitude',
    (value) => value >= 0 && value <= DEGREES_MAGNITUDE_MAX,
    false,
  );
}

export function parseDegreesSigned(candidate: unknown): ParseResult<DegreesSigned> {
  return parseBounded<DegreesSigned>(
    candidate,
    'degrees-signed',
    (value) => value > DEGREES_SIGNED_MIN_EXCLUSIVE && value <= DEGREES_SIGNED_MAX,
    false,
  );
}

export function parseMilliseconds(candidate: unknown): ParseResult<Milliseconds> {
  return parseBounded<Milliseconds>(candidate, 'milliseconds', (value) => value >= 0, false);
}

export function parseUnitInterval(candidate: unknown): ParseResult<UnitInterval> {
  return parseBounded<UnitInterval>(
    candidate,
    'unit-interval',
    (value) => value >= 0 && value <= 1,
    false,
  );
}

export function parseCentimetres(candidate: unknown): ParseResult<Centimetres> {
  return parseBounded<Centimetres>(candidate, 'centimetres', (value) => value >= 0, false);
}

export function parsePositiveCount(candidate: unknown): ParseResult<PositiveCount> {
  return parseBounded<PositiveCount>(candidate, 'positive-count', (value) => value >= 1, true);
}

/**
 * Magnitude of a signed angular displacement.
 *
 * Total by construction: the signed range is `(-180, 180]`, so the absolute value always lands
 * inside the magnitude range `[0, 180]` and no parse can fail here.
 */
export function magnitudeOf(signed: DegreesSigned): DegreesMagnitude {
  return Math.abs(signed) as DegreesMagnitude;
}

/**
 * Difference between two magnitudes, as a signed displacement.
 *
 * Total by construction: both inputs are in `[0, 180]`, so the difference is in `[-180, 180]`, and
 * the only value outside the signed range is exactly `-180`, which is normalized to `180` because
 * the two denote the same displacement.
 */
export function differenceOf(left: DegreesMagnitude, right: DegreesMagnitude): DegreesSigned {
  const difference = left - right;
  return (
    difference === DEGREES_SIGNED_MIN_EXCLUSIVE ? DEGREES_SIGNED_MAX : difference
  ) as DegreesSigned;
}
