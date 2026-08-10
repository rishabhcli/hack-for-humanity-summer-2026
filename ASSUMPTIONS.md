# Assumptions

This file records decisions made without user input. Each entry includes the cheapest later verification path.

## 2026-08-09 — Node compatibility window

- **Decision:** Node 24.19.0 is the CI/reference runtime; patched Node 24.19 through Node 26 is accepted for local development, with Node 24 types controlling available APIs.
- **Reason:** the host currently runs Node 26.5.1, while Node 24.19.0 is the supported LTS reference and avoids the security defects in 24.18.0.
- **Verify later:** run `verify-all` in CI on 24.19.0 and locally on the supported host; narrow the range if behavior diverges.

## 2026-08-09 — Foreign reserved ports fail closed

- **Decision:** any foreign listener on `4180-4189`, including an unallocated reserved port, fails preflight. No automatic relocation occurs. The committed `4180-4183` service mapping is fixed; an approved relocation must synchronously update `ports.env`, lifecycle and Playwright configuration/tests, ADR-0002, this register, and clean-checkout evidence.
- **Reason:** this is the stronger resolution of the conflicting relocation and all-ports-fail clauses in GOAL.md §0A; see ADR-0002.
- **Verify later:** amend GOAL.md explicitly if reserved foreign ports are intended to be warnings, then update ADR-0002 and integration tests.

## 2026-08-09 — Empty fixture corpus semantics

- **Decision:** the fixture service may report infrastructure readiness with `fixtureCount: 0` only while also returning `corpusReady: false`. This is not validation evidence.
- **Reason:** Tier 0 needs a real manifest-backed service without inventing video fixtures or claiming the validation area exists.
- **Verify later:** add the first consented or synthetic ground-truth media with provenance and digest, then change `corpusReady` only when its schema/range checks pass.

## 2026-08-09 — Tooling declaration isolation

- **Decision:** browser code and the checked-JavaScript script configuration use `skipLibCheck: false`. The TypeScript-only tool configuration uses `skipLibCheck: true` because Workbox and optional `vite-plugin-pwa` declarations do not typecheck under the repository's `exactOptionalPropertyTypes` setting.
- **Reason:** all repository-owned scripts and script tests remain strictly checked; only dependency declaration bodies reached by Playwright/Vite/PWA configuration are skipped to isolate observed third-party defects.
- **Verify later:** remove the tool-only override after a PWA dependency upgrade and run all three typecheck configs; never extend the override to repository script checking.

## 2026-08-10 — Browser trust is key-scoped in tests

- **Decision:** Playwright derives the SHA-256 SPKI fingerprint of the repository-generated development certificate and grants Chromium an exception only for that public key. Each worker profile is erased before use.
- **Reason:** Playwright's general HTTP-error option did not cover the service-worker script fetch; disabling all browser certificate validation would hide the exact failure the PWA test must expose.
- **Verify later:** replace the self-signed development certificate with a locally trusted repository CA only if the same fresh-registration and offline-response assertions continue to pass without a broader trust surface.

## 2026-08-10 — PID ownership fails closed

- **Decision:** lifecycle record schema 2 binds a service to its exact configured port, canonical command, repository cwd, process start fingerprint, run ID, and a per-run environment token. Shutdown additionally requires that the exact PID be the sole loopback listener immediately before either signal.
- **Reason:** the earlier record shape could have treated a forged same-cwd PID as owned. Refusing to clean up an ambiguous or already-unbound process is safer than risking a sibling or unrelated process.
- **Verify later:** a future authenticated supervisor/control socket may replace PID signaling if it offers stronger ownership and crash recovery without weakening the no-foreign-kill rule.

## 2026-08-10 — Repository-owned tool caches

- **Decision:** npm, Vite, and Playwright caches live only under `.dev/cache/`; bootstrap installs the exact Playwright Chromium revision there.
- **Reason:** sixteen repositories operate in parallel, and a shared browser or package-manager cache would violate the namespace-isolation contract and make clean-machine browser evidence false-green.
- **Verify later:** run bootstrap and `verify-all` in a clean CI checkout, then confirm the uploaded dependency evidence names the same browser revision.

## 2026-08-10 — Planned layout is policy, not scaffolding

- **Decision:** the planned domain paths are reserved ownership areas in the boundary policy, but their physical directories are created only when a production slice supplies working code, tests, and documentation.
- **Reason:** empty directories and placeholder files would imply implementation progress without an owned behavior, while the boundary checker can enforce the names independently of disk presence.
- **Verify later:** when the first domain package is added, prove its ownership/import rules with boundary fixtures and the package's domain tests; do not add the other directories preemptively.
