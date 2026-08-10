# ADR-0005: Domain invariants are encoded as capabilities, not as checks callers must remember

- **Status:** Accepted
- **Date:** 2026-08-10
- **Scope:** Tier 1 encoding strategy for the seven domain invariants

## Context

`AGENTS.md` lists seven domain invariants and requires that they be encoded "in types, database
constraints, protocol schemas, assertions at trust boundaries, and tests", explicitly not in
comments or UI copy. `GOAL.md` §6 Tier 1 sharpens this: if the answer to "where is this encoded" is
a comment, a convention, or a UI string, the work is not done.

The obvious implementation of I2 — "a measurement is withheld when geometry or pose confidence
fails" — is a `checkQuality()` call at the top of the measurement path. That is exactly the
encoding the tier forbids, because nothing stops the next code path from not calling it. The
invariant would hold only as long as every author remembers it, and the failure is silent: the
system produces a plausible number instead of refusing.

There is no database in this product — sessions live in the browser — so a database constraint is
not available as an enforcement mechanism. The enforcement has to live in the type system and at
runtime boundaries.

## Decision

Encode invariants as **capability tokens plus a runtime registry**, so that possessing the right to
produce a value is inseparable from having earned it.

1. **The gate is the only mint.** `evaluateTrialQuality` is the only function that returns a
   `QualityAcceptance`. Its brand is a module-private `Symbol`, so no other module can write the
   key in an object literal.
2. **The consumer requires the token.** `recordTrial` takes a `QualityAcceptance` in its input
   type. The `measured` arm of `TrialOutcome` carries one. There is no way to reach a measured
   outcome without holding a token, and the union has no third arm for "measured but uncertain".
3. **The token is verified at runtime, not merely typed.** A module-private `WeakSet` records every
   acceptance actually minted, and `isAuthenticAcceptance` checks membership by identity. A caller
   who writes `as unknown as QualityAcceptance`, or who structurally clones a genuine acceptance —
   which does copy the symbol key, since object spread copies own symbol properties — still gets a
   withheld outcome. The type is the ergonomics; the registry is the enforcement.
4. **Tokens are scoped.** An acceptance carries the digest of the calibration it was evaluated
   against, and `recordTrial` refuses one issued against a different reference. This is what stops
   a valid token from being replayed onto the wrong neutral reference, and it is where I2 and I4
   meet.
5. **Refusal is a value, not an exception.** Every rejection returns a tagged result carrying a
   stable code, the observed value, the violated bound, its unit, a retryability classification,
   and a safe non-diagnostic message. Nothing throws on a domain-invalid input, which keeps the
   whole surface property-testable.
6. **Every attack gets a named property test with a stated case count.** For each invariant, at
   least one property generates adversarial inputs — forged tokens, hostile numbers, malformed
   identifiers, out-of-range geometry — and asserts the refusal, rather than only asserting the
   happy path.

## Alternatives considered

- **A `checkQuality()` call at the top of the measurement path.** Rejected: it is the encoding
  Tier 1 explicitly names as insufficient. Nothing prevents a new path from omitting it.
- **A boolean `qualityPassed: boolean` field on the measurement input.** Rejected: a boolean is
  forgeable by writing `true`, carries no evidence of what was checked, and cannot be scoped to a
  calibration.
- **A branded type with no runtime registry.** Rejected as the sole mechanism: `as unknown as T`
  defeats it silently, and a structural clone defeats it even without a cast. It is kept as the
  compile-time layer on top of the registry.
- **Throwing on invalid input.** Rejected: exceptions make refusal paths harder to enumerate and
  property-test, and they encourage callers to wrap and swallow. A refused measurement is an
  expected outcome of this instrument, not an error.
- **A nominal class with a private constructor.** Comparable strength, and a reasonable future
  refactor, but structural cloning and `Object.create` still bypass a `#private` check in ways the
  `WeakSet` does not, and classes would push these pure domain modules toward identity semantics
  they do not otherwise need.

## Consequences

- A future contributor cannot produce a measured trial outcome without going through the quality
  gate. The compiler stops the ordinary mistake and the registry stops the deliberate bypass.
- The measured/withheld union has no room for a "low-confidence but shown anyway" state, which is
  the specific failure mode `AGENTS.md` calls a prohibited shortcut.
- Acceptances are not serializable across a process boundary: the registry is in-memory and keyed
  on identity. Any future storage or worker boundary must re-run the gate on the far side rather
  than transporting a token, which is the correct behaviour and is recorded here so it is not
  discovered as a surprise.
- Property tests must construct genuine acceptances through the gate, which keeps test fixtures
  honest about what a passing observation actually looks like.

## Reversal

Reverting means deleting the registry and the token parameter and reinstating an imperative check.
That reintroduces the silent-omission failure mode and would need its own ADR arguing why the
invariant no longer needs structural enforcement. Narrowing is possible without reversal: the
`WeakSet` can be replaced by any stronger authenticity mechanism as long as forged and cloned
tokens keep failing the named property tests in
`src/measurement/trial-outcome.test.ts`.
