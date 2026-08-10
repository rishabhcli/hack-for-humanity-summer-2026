# ADR-0003: Local process ownership and authenticated readiness

- **Status:** Accepted
- **Date:** 2026-08-10
- **Scope:** Tier 0 local lifecycle safety boundary

## Context

Sixteen repository sessions share one host process table and loopback interface. The absolute repository contract forbids signaling a process this repository did not start. A PID file containing only a PID, cwd, and copied command is not sufficient authority: those values can be stale, PID values can be reused, and a forged record could point at an unrelated same-cwd process.

Readiness has the related false-green risk. A foreign HTTPS listener can return status 200, and a stale preview can remain alive after its source or built artifact changes.

## Decision

1. Version lifecycle ownership records independently. Schema 2 has an exact key set and binds the record filename/definition to the service ID, literal loopback host, configured port, repository realpath, canonical executable and argument sequence, process start fingerprint, run ID, artifact/configuration/certificate digests, and two random per-run values.
2. Inject a distinct ownership token and readiness secret into a deliberately sanitized child environment. Do not inherit arbitrary parent variables or credentials.
3. Treat the record as one corroborating signal, never as authority by itself. Before retaining, probing, or signaling, re-read live command, cwd, start fingerprint, run ID/ownership environment, listener PID, and literal loopback binding.
4. Before `SIGTERM` and again before any `SIGKILL`, require the exact PID to remain the sole listener on its configured `127.0.0.1` port. If any signal becomes ambiguous, refuse and retain the record for manual reconciliation.
5. Authenticate every readiness response with an HMAC over a fresh challenge plus the full service/run/config/artifact/certificate identity. Pin the repository certificate in Node probes.
6. Serialize lifecycle mutations with an exclusive lock and write records atomically with mode `0600`.
7. If startup fails after a detached child is spawned but before its record is committed, use the direct child identity and captured start fingerprint to terminate and confirm that just-spawned child before surfacing the original failure.

## Alternatives considered

- **PID file only:** rejected because a stale or forged number can target an unrelated process.
- **Command and cwd comparison only:** rejected because both are observable and reproducible by another same-user process.
- **Broad process-name cleanup:** prohibited because it can terminate sibling work.
- **TCP or static status readiness:** rejected because it cannot establish service, run, or artifact identity.
- **Always kill a canonical-looking orphan:** rejected because cleanup convenience cannot outrank the no-foreign-kill invariant.
- **Authenticated supervisor socket:** potentially stronger, but deferred until its own lifecycle, stale-socket, portability, and recovery costs are designed and tested.

## Consequences

- Ambiguous, malformed, downgraded, wrong-command, wrong-environment, wrong-listener, or stale records fail closed.
- A process that closes its listener but remains alive may require manual reconciliation; the lifecycle deliberately does not guess that it still owns the PID.
- Local health is more expensive than a socket probe because it revalidates operating-system identity and a semantic HTTPS body. Timeouts remain bounded and are sized for the shared sixteen-repository host.
- Failure-path integration and property tests are release-blocking because this boundary protects other repositories, not only this application.

## Reversal

Replace PID signaling with an authenticated repository-local supervisor/control channel. Demonstrate exact-owner shutdown, crash recovery, stale endpoint handling, PID reuse resistance, and foreign-listener survival under fault injection before removing schema-2 validation or listener rechecks.
