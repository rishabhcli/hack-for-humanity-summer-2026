# ADR-0004: The dependency-maintenance gate validates a committed snapshot offline

- **Status:** Accepted
- **Date:** 2026-08-10
- **Scope:** Tier 0 verification determinism and supply-chain evidence

## Context

`npm run check:dependencies` runs inside `verify-all`, which every release gate is evaluated by. Its
dependency-maintenance step originally re-queried the npm registry and the OSV advisory database on
every invocation and then byte-compared the live result against the committed artifact.

That construction makes the gate fail for reasons that have nothing to do with this repository:

- `ageDaysAtSnapshot` is derived from wall-clock time, so the artifact goes stale every midnight UTC.
- `registryModifiedAt` and `latestStable` change whenever any of the twelve direct dependencies
  publishes anything. `typescript-eslint` alone publishes roughly weekly.
- The gate requires network reachability to two third parties, so an OSV or registry outage turns a
  correct commit red.

This was observed directly: the first CI run and the first local `verify-all` of this session both
failed at `check:dependencies` with `DEPENDENCY_MAINTENANCE_EVIDENCE_STALE` while the repository
itself was unchanged and correct. A gate that goes red on a third party's release schedule trains
its readers to ignore it, which is worse than not having it.

`GOAL.md` §3.4 step 1 classifies a gate that cannot be re-run by a committed command as a defect in
its own right, and §6 Tier 8 requires every published number to be regenerable _from immutable
inputs_. The npm registry is not an immutable input. The committed snapshot is.

## Decision

Split the two responsibilities that were fused into one command.

1. **`npm run evidence:dependency-maintenance` (online, explicit).** Queries the registry and OSV,
   builds the snapshot, validates it, and writes `evidence/tier-0/dependency-maintenance.json`. This
   is the regenerating command the artifact names.
2. **`... --check` (offline, deterministic, inside `verify-all`).** Performs no network access. It
   validates the committed artifact against the committed `package.json` and against itself:
   - the bytes are the canonical sorted-key serialization;
   - the recorded dependency set equals the exact direct dependency set and versions;
   - every derived field is **recomputed**, not trusted — `ageDaysAtSnapshot` from `snapshotAt` and
     the recorded publish timestamp, the maintenance bucket from that age, the repository URL from
     the recorded registry value, and the advisory summary from the advisory list;
   - no recorded timestamp postdates the snapshot it claims to have been observed in;
   - the snapshot is not in the future and is not older than `MAX_SNAPSHOT_AGE_DAYS` (30).
3. **Two supply-chain findings fail the gate closed rather than being recorded as notes.** A
   deprecated locked version fails with `DEPENDENCY_MAINTENANCE_LOCKED_VERSION_DEPRECATED`, and an
   advisory that affects the exact locked version and has not been withdrawn fails with
   `DEPENDENCY_MAINTENANCE_ADVISORY_UNRESOLVED`.
4. **Freshness is enforced by age, not by upstream equality.** The 30-day bound makes an unrefreshed
   snapshot expire on a schedule this repository controls. A scheduled workflow refreshes it on a
   cadence well inside that bound so expiry is a real alarm rather than routine noise.

## Alternatives considered

- **Keep the live byte-comparison.** Rejected: it couples this repository's release gate to third
  parties' publish schedules and uptime, and it produces red builds that carry no information about
  this repository.
- **Compare only the fields that do not drift.** Rejected: the drifting fields (`latestStable`,
  advisories) are the security-relevant ones, so excluding them would hollow out the check while
  keeping its network dependency.
- **Drop the maintenance evidence entirely and rely on `npm audit`.** Rejected: `npm audit` covers
  the npm advisory database against the locked graph; it does not record per-direct-dependency
  release age, deprecation, repository provenance, or OSV coverage, and it produces no committed
  artifact.
- **Never expire the snapshot.** Rejected: a snapshot with no age bound silently becomes a claim
  about a moment nobody remembers, which is exactly the unregenerable-claim failure §6 Tier 8 exists
  to prevent.

## Consequences

- `verify-all` no longer performs network access in this step, so it is runnable and reproducible
  offline and in a clean checkout.
- Refreshing the snapshot is now a deliberate act with its own command and its own scheduled run,
  and the refresh diff is the place where dependency drift becomes visible.
- A newly published advisory against a locked version is no longer merely recorded — it fails the
  gate. Clearing it requires an upgrade or a reviewed, recorded decision; it cannot be ignored.
- The 30-day bound means a repository left untouched for a month fails `verify-all` until the
  snapshot is refreshed. This is intended: the alternative is publishing a stale security claim.
- The validator's rejection paths are covered by named unit tests in
  `scripts/dependency-maintenance-evidence.test.mjs`, so hand-editing the artifact to make the gate
  pass fails a test rather than succeeding quietly.

## Reversal

Reverting means restoring the live byte-comparison in `--check` and deleting the offline validator
and its tests. Doing so reintroduces third-party coupling into every release gate and would need an
ADR of its own explaining why nondeterministic verification became acceptable. A narrower change —
adjusting `MAX_SNAPSHOT_AGE_DAYS` — requires only updating the constant, its ADR entry, and the
scheduled refresh cadence, and must keep the refresh cadence strictly inside the bound.
