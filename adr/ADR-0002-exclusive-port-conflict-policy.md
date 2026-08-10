# ADR-0002: Fail closed on any foreign listener in the exclusive port block

- **Status:** Accepted
- **Date:** 2026-08-09
- **Scope:** GOAL.md §0A conflict resolution

## Context

GOAL.md §0A.2 says that an allocated port held by another process may be moved to an unassigned port in `4180-4189`, while §0A.4 requires `dev:preflight` to fail if **any** port in that entire block is held by a foreign process. Moving the repository service cannot remove the original foreign listener, so both clauses cannot be satisfied by automatic relocation.

## Decision

Apply the stronger, fail-closed interpretation:

1. Inspect all ten ports `4180-4189` before startup.
2. Fail if any listener is not proven to be a process recorded and owned by this repository.
3. Never signal, replace, reuse, or route around a foreign listener.
4. Never choose a new port automatically. The current `4180-4183` mapping is fixed by committed configuration. A future allocation change must update `ports.env`, lifecycle and Playwright configuration/tests, `ASSUMPTIONS.md`, this ADR, and clean-checkout evidence as one synchronized change.
5. Relocation is usable only after the block is free of foreign listeners; it does not waive the all-ports preflight rule.

This interpretation is stricter than silently continuing and best protects the fifteen concurrent repositories from cross-session interference.

## Consequences

- A foreign listener anywhere in the reserved block makes the local lifecycle unavailable until that listener exits, even if an assigned service port remains free.
- Preflight reports the exact port and `lsof` evidence but does not kill anything.
- The integration suite creates a foreign listener on reserved port 4189, proves preflight fails, and proves the listener remains alive.

## Reversal

GOAL.md must first be amended to state whether unallocated foreign ports are warnings or failures. Then update the parser, lifecycle and Playwright configuration/tests, `ports.env`, `ASSUMPTIONS.md`, this ADR, and the clean-checkout evidence together. No single file is an independent relocation switch.
