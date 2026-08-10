import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DEGREES_MAGNITUDE_MAX,
  DEGREES_SIGNED_MAX,
  DEGREES_SIGNED_MIN_EXCLUSIVE,
  type DegreesMagnitude,
  differenceOf,
  magnitudeOf,
  parseCentimetres,
  parseDegreesMagnitude,
  parseDegreesSigned,
  parseMilliseconds,
  parsePositiveCount,
  parseUnitInterval,
} from './units';

const SEED = 20_260_810;

/** Values that are numbers to JavaScript but never valid quantities in this domain. */
const hostileNumbers = fc.constantFrom(
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
);

/** Values that are not numbers at all, as they would arrive from an untrusted boundary. */
const nonNumbers = fc.oneof(
  fc.string(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.object(),
  fc.array(fc.integer()),
  fc.bigInt().map((value) => value.toString()),
);

describe('unit parsing rejects everything outside its declared range', () => {
  it('property: no non-number is ever accepted as any unit — 500 cases, seed 20260810', () => {
    fc.assert(
      fc.property(nonNumbers, (candidate) => {
        for (const parse of [
          parseCentimetres,
          parseDegreesMagnitude,
          parseDegreesSigned,
          parseMilliseconds,
          parsePositiveCount,
          parseUnitInterval,
        ]) {
          const result = parse(candidate);
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.code).toBe('UNIT_NOT_A_NUMBER');
          }
        }
      }),
      { numRuns: 500, seed: SEED },
    );
  });

  it('property: NaN and the infinities are never accepted as any unit — 300 cases, seed 20260810', () => {
    fc.assert(
      fc.property(hostileNumbers, (candidate) => {
        for (const parse of [
          parseCentimetres,
          parseDegreesMagnitude,
          parseDegreesSigned,
          parseMilliseconds,
          parsePositiveCount,
          parseUnitInterval,
        ]) {
          const result = parse(candidate);
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.code).toBe('UNIT_NOT_FINITE');
          }
        }
      }),
      { numRuns: 300, seed: SEED },
    );
  });

  it('property: an accepted value round-trips unchanged and an out-of-range one is refused — 1000 cases, seed 20260810', () => {
    fc.assert(
      fc.property(fc.double({ noDefaultInfinity: true, noNaN: true }), (candidate) => {
        const magnitude = parseDegreesMagnitude(candidate);
        const inMagnitudeRange = candidate >= 0 && candidate <= DEGREES_MAGNITUDE_MAX;
        expect(magnitude.ok).toBe(inMagnitudeRange);
        if (magnitude.ok) {
          expect(magnitude.value).toBe(candidate === 0 ? 0 : candidate);
        } else {
          expect(magnitude.code).toBe('UNIT_OUT_OF_RANGE');
        }

        const signed = parseDegreesSigned(candidate);
        expect(signed.ok).toBe(
          candidate > DEGREES_SIGNED_MIN_EXCLUSIVE && candidate <= DEGREES_SIGNED_MAX,
        );

        const unitInterval = parseUnitInterval(candidate);
        expect(unitInterval.ok).toBe(candidate >= 0 && candidate <= 1);

        const milliseconds = parseMilliseconds(candidate);
        expect(milliseconds.ok).toBe(candidate >= 0);
      }),
      { numRuns: 1000, seed: SEED },
    );
  });

  it('property: a count must be a whole number of at least one — 500 cases, seed 20260810', () => {
    fc.assert(
      fc.property(fc.double({ noDefaultInfinity: true, noNaN: true }), (candidate) => {
        const result = parsePositiveCount(candidate);
        expect(result.ok).toBe(Number.isInteger(candidate) && candidate >= 1);
        if (!result.ok && Number.isInteger(candidate)) {
          expect(result.code).toBe('UNIT_OUT_OF_RANGE');
        }
        if (!result.ok && !Number.isInteger(candidate)) {
          expect(result.code).toBe('UNIT_NOT_INTEGER');
        }
      }),
      { numRuns: 500, seed: SEED },
    );
  });

  it('normalizes negative zero so two equal magnitudes serialize identically', () => {
    const result = parseDegreesMagnitude(-0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.is(result.value, 0)).toBe(true);
      expect(JSON.stringify({ value: result.value })).toBe('{"value":0}');
    }
  });

  it('accepts each range boundary and refuses the value just outside it', () => {
    expect(parseDegreesMagnitude(0).ok).toBe(true);
    expect(parseDegreesMagnitude(180).ok).toBe(true);
    expect(parseDegreesMagnitude(-0.000_001).ok).toBe(false);
    expect(parseDegreesMagnitude(180.000_001).ok).toBe(false);

    expect(parseDegreesSigned(180).ok).toBe(true);
    expect(parseDegreesSigned(-180).ok).toBe(false);
    expect(parseDegreesSigned(-179.999).ok).toBe(true);

    expect(parseUnitInterval(0).ok).toBe(true);
    expect(parseUnitInterval(1).ok).toBe(true);
    expect(parseUnitInterval(1.000_001).ok).toBe(false);

    expect(parsePositiveCount(1).ok).toBe(true);
    expect(parsePositiveCount(0).ok).toBe(false);
  });
});

describe('angular arithmetic stays inside its declared ranges', () => {
  it('property: the magnitude of any signed displacement is a valid magnitude — 1000 cases, seed 20260810', () => {
    fc.assert(
      fc.property(
        fc
          .double({
            max: DEGREES_SIGNED_MAX,
            min: DEGREES_SIGNED_MIN_EXCLUSIVE,
            noDefaultInfinity: true,
            noNaN: true,
          })
          .filter((value) => value > DEGREES_SIGNED_MIN_EXCLUSIVE),
        (value) => {
          const signed = parseDegreesSigned(value);
          expect(signed.ok).toBe(true);
          if (signed.ok) {
            const magnitude = magnitudeOf(signed.value);
            expect(parseDegreesMagnitude(magnitude).ok).toBe(true);
            expect(magnitude).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 1000, seed: SEED },
    );
  });

  it('property: the difference of any two magnitudes is a valid signed displacement — 1000 cases, seed 20260810', () => {
    const magnitude = fc
      .double({ max: DEGREES_MAGNITUDE_MAX, min: 0, noDefaultInfinity: true, noNaN: true })
      .map((value) => {
        const parsed = parseDegreesMagnitude(value);
        if (!parsed.ok) {
          throw new Error('generator produced an out-of-range magnitude');
        }
        return parsed.value;
      });

    fc.assert(
      fc.property(magnitude, magnitude, (left: DegreesMagnitude, right: DegreesMagnitude) => {
        const difference = differenceOf(left, right);
        expect(parseDegreesSigned(difference).ok).toBe(true);
      }),
      { numRuns: 1000, seed: SEED },
    );
  });

  it('normalizes the single signed value outside the range to its equivalent', () => {
    const zero = parseDegreesMagnitude(0);
    const half = parseDegreesMagnitude(180);
    expect(zero.ok && half.ok).toBe(true);
    if (zero.ok && half.ok) {
      // 0 - 180 is -180, which denotes the same displacement as +180 and is normalized to it.
      expect(differenceOf(zero.value, half.value)).toBe(180);
      expect(differenceOf(half.value, zero.value)).toBe(180);
    }
  });
});
