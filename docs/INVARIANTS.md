# Domain invariant register

The seven invariants in `AGENTS.md` and `GOAL.md` §6 Tier 1, with the exact place each one is
machine-enforced and the exact named test that attacks it.

**An invariant is only recorded as encoded when its enforcement is a type, a schema, or a runtime
boundary assertion.** A comment, a convention, or a UI string is not an encoding, and an invariant
defended only that way is listed here as _not encoded_ even where the current behaviour happens to
be correct.

Encoding strategy and its alternatives: [ADR-0005](../adr/ADR-0005-invariants-as-capabilities.md).

## Status summary

| Invariant                                                     | Encoded             |
| ------------------------------------------------------------- | ------------------- |
| I1 — never outputs a diagnosis or return-to-activity decision | Not yet             |
| I2 — measurement withheld when geometry or confidence fails   | **Yes**             |
| I3 — improvement reported only against measurement error      | **Yes**             |
| I4 — neutral reference and calibration versioned per session  | **Yes**             |
| I5 — camera/torso motion separated or the trial is rejected   | Partial (gate only) |
| I6 — raw frames not transmitted or retained by default        | Not yet             |
| I7 — clinical thresholds require an authoritative citation    | Not yet             |

## I2 — A measurement is withheld when geometry or pose confidence fails

**Encoded as a capability token.** `evaluateTrialQuality` is the only mint of a `QualityAcceptance`;
`recordTrial` requires one and re-verifies it against a module-private registry, so neither omitting
the check nor forging its result produces a number.

- Type / boundary: `src/quality/trial-quality.ts` — `QualityAcceptance`, `mintedAcceptances`,
  `isAuthenticAcceptance`
- Consumer boundary: `src/measurement/trial-outcome.ts` — `TrialInput.acceptance`, `recordTrial`
- Union shape: `TrialOutcome` has exactly `measured` and `withheld`. There is no arm that reports a
  number with a caveat.

| Attack                                              | Named property test                                                             | Cases |
| --------------------------------------------------- | ------------------------------------------------------------------------------- | ----- |
| Any observation outside any bound must be refused   | `property: acceptance happens if and only if every bound holds`                 | 2000  |
| A refusal must always name a reason                 | `property: a refusal always names at least one reason and never an empty list`  | 1500  |
| An acceptance-shaped object must never be authentic | `property: no object shaped like an acceptance is ever authentic`               | 1000  |
| A forged token must never yield a number            | `property: a forged acceptance never yields a measured outcome`                 | 1000  |
| Too few endpoint frames must never be measured      | `property: an endpoint window below the minimum sample count is never measured` | 400   |
| A moving endpoint must never be measured            | `property: an endpoint noisier than the session's own jitter is never measured` | 600   |

**Boundary behaviour on malformed input:** every scalar arriving from outside the domain is parsed
by `src/measurement/units.ts`, which refuses non-numbers (`UNIT_NOT_A_NUMBER`), `NaN` and the
infinities (`UNIT_NOT_FINITE`), non-integers where a count is required (`UNIT_NOT_INTEGER`), and
out-of-range values (`UNIT_OUT_OF_RANGE`). No unparsed number can reach a domain function, because
the domain signatures take branded types.

**Not yet done for this invariant:** the fault-injection scenario that attacks it while the landmark
adapter is failing, and the production alert plus runbook. Both are blocked on Tier 3 adapters and
Tier 11 operations respectively, and are tracked here rather than being claimed.

## I4 — Neutral reference and calibration are versioned per session

**Encoded as an identified, versioned record.** A neutral reference exists only as a
`CalibrationRecord`, constructible only by `buildCalibrationRecord` (fresh capture, current
algorithm version) or `restoreCalibrationRecord` (stored capture, any readable version, preserved
rather than upgraded).

- Type / boundary: `src/protocol/calibration.ts`
- Every measured outcome carries `referenceDigest` and `sessionId`, so a number can always name the
  calibration it was produced under.
- `measuredTrialsFor` in `src/measurement/trial-outcome.ts` drops trials from another reference
  rather than pooling them.

| Attack                                                        | Named property test                                                                     | Cases |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----- |
| A capture too short or too sparse must not become a reference | `property: a capture too short or too sparse to trust is never turned into a reference` | 600   |
| A malformed session identifier must be refused                | `property: no malformed session identifier is ever accepted`                            | 500   |
| A malformed reference digest must be refused                  | `property: no digest that is not a full lowercase sha-256 identifies a reference`       | 500   |
| A fresh capture must not claim another algorithm version      | `property: a fresh capture claiming any version but the current one is refused`         | 400   |
| A stored record must not claim an unreadable version          | `property: a restored record claiming an unreadable version is refused`                 | 400   |
| Comparability must be determined only by version              | `property: comparability is reflexive, symmetric, and version-determined`               | 500   |
| Trials must never be pooled across references                 | `property: a summary only ever draws on trials from its own reference`                  | 500   |

**Boundary behaviour on malformed input:** `CalibrationDraft` takes `unknown` for every field, so
a record restored from storage is parsed rather than trusted. Each failure returns a distinct
`CALIBRATION_*` code.

**Not yet done for this invariant:** the session-pair comparison that refuses across calibration
versions at the report boundary (I3's home), the fault-injection scenario, and the production alert.

## I3 — Improvement is reported only relative to declared measurement error

**Encoded by making the alternative unrepresentable.** No type in `src/measurement/change-claim.ts`
carries an observed change without also carrying the minimal detectable change it was judged
against, and the arm that asserts a change can only be produced by `compareBlocks`, which requires a
`RepeatabilityEstimate` for each block.

- Type / boundary: `src/measurement/change-claim.ts` — `ChangeVerdict`, `compareBlocks`
- Derivation: `src/measurement/repeatability.ts` — `estimateRepeatability`,
  `MDC95 = 1.96 * sqrt(2) * SEM`, with the sample (`n - 1`) standard deviation so the floor is never
  systematically understated
- A comparison of two blocks combines both blocks' floors in quadrature, so a difference is never
  judged against only one block's error.

| Attack                                                      | Named property test                                                           | Cases |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- | ----- |
| A verdict must never omit the noise floor                   | `property: no verdict ever omits the minimal detectable change`               | 800   |
| A change must be asserted only above the floor              | `property: a change is asserted if and only if it exceeds the noise floor`    | 800   |
| Identical blocks must never read as a change                | `property: identical blocks are never reported as a change`                   | 400   |
| A refused comparison must never assert a change             | `property: a refused comparison never asserts a change`                       | 400   |
| A bias must never exceed the average distance from zero     | `property: absolute error is never below the magnitude of constant error`     | 600   |
| The floor must never fall below the scatter it derives from | `property: the noise floor is never smaller than the scatter it derives from` | 600   |

**Boundary behaviour on malformed input:** a block with fewer than `MINIMUM_REPEATABILITY_TRIALS`
(6) measured trials returns `STATISTICS_TOO_FEW_TRIALS` rather than an MDC derived from a scatter
estimate dominated by its own sampling error. A derived floor outside the representable angular
range returns `STATISTICS_VALUE_OUT_OF_RANGE`.

**Refusals that satisfy Tier 5.3:** `CHANGE_REFUSED_CALIBRATION_VERSION_MISMATCH`,
`CHANGE_REFUSED_DIFFERENT_NEUTRAL_REFERENCE`, `CHANGE_REFUSED_BLOCK_ORDER_INVALID`, and
`CHANGE_REFUSED_UNCERTAINTY_UNAVAILABLE`.

**Not yet done for this invariant:** the SEM estimator is single-session and captures trial-to-trial
noise only, not between-day variation in the neutral reference. That limitation must appear where
the number is shown, which is Tier 2's report work. The estimator has also not been validated
against a known-angle ground truth; until it is, the floor is arithmetically correct but its inputs
are unvalidated.

## I5 — Camera and torso movement are separated from intended head rotation

**Partially encoded.** The quality gate refuses a trial whose endpoint window shows camera motion or
torso motion beyond the supported envelope — `QUALITY_CAMERA_MOTION_DETECTED` and
`QUALITY_TORSO_MOTION_NOT_SEPARABLE` in `src/quality/trial-quality.ts`, covered by the
`acceptance happens if and only if every bound holds` property above.

**What is missing:** the estimator that actually _separates_ the three motion sources. Today the
observation arrives with `cameraMotionDeg` and `torsoMotionDeg` already attributed; nothing yet
computes that attribution or proves it is correct. Until `src/vision` exists, this invariant is
enforced only against inputs that are already honest, which is not enforcement. It is recorded as
partial for that reason.

## I1, I6, I7 — Not yet encoded

These are named here so their absence is visible rather than implied:

- **I1 — no diagnosis or return-to-activity decision.** Requires a citation-gated displayable-copy
  type plus a build-time content check over shipped copy. The current UI copy is correct but is
  copy, not enforcement.
- **I6 — raw frames not transmitted or retained.** The E2E check proves no third-party request
  occurs on the readiness path, but no camera is opened yet, so nothing about the frame path is
  currently provable.
- **I7 — clinical thresholds require an authoritative citation.** Requires the threshold registry
  and a CI content gate.

## How to extend this register

When an invariant becomes encoded, add its section with the file path of the encoding, the named
property test, and the case count, and move its row to **Yes**. Do not mark an invariant encoded
because the behaviour is currently correct; mark it encoded when the wrong behaviour has become
unrepresentable or is rejected at a boundary.
