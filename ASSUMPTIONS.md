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

## 2026-08-10 — Verification gates do not depend on third-party liveness

- **Decision:** `verify-all` performs no network query whose result this repository does not control. The dependency-maintenance step validates the committed snapshot offline and bounds its age at 30 days; the online refresh is a separate explicit command. See ADR-0004.
- **Reason:** the live byte-comparison turned every upstream publish into a red release gate, which was observed twice — in GitHub Actions run 31402823988 and in the first local `verify-all` of this session — while the repository itself was correct. A gate that fails for reasons outside the repository teaches its readers to ignore it.
- **Verify later:** if a scheduled refresh ever reports drift that the offline validator would have accepted, tighten the validator rather than restoring the live comparison.

## 2026-08-10 — The pinned Node runtime is fetched into `.dev/`, not installed system-wide

- **Decision:** `.dev/toolchain/` holds the `.node-version` runtime (24.19.0), checksum-verified against the official `SHASUMS256.txt`, and local verification runs against it so the development host matches CI exactly.
- **Reason:** the host default is Node 26.5.1 while CI resolves `.node-version`. Verifying on a different runtime than CI would make a green local run weak evidence. `.dev/` is git-ignored, so this does not alter any sibling repository or the machine's global toolchain.
- **Verify later:** the build artifact manifest was observed identical under both 24.19.0 and 26.5.1 (`4750376cedb8e16a6a634bdc2afb131c62bface60490f5e8d8918bc1a2959f13`); re-check that equality after any Vite, Rollup, or esbuild upgrade rather than assuming it persists.

## 2026-08-10 — Lifecycle ownership binds to the launching interpreter

- **Decision:** every `dev:*` command in a session must run under the same Node binary, and that binary must be the `.node-version` runtime. `expectedProcessCommand` recomputes the canonical command from `process.execPath`, so a service started by one interpreter is correctly refused as unowned by another.
- **Reason:** observed as `PID_RECORD_INVALID service=fixtures` when services started by the host's Node 26.5.1 were inspected by the pinned Node 24.19.0. Failing closed is the correct behaviour: the alternative — trusting an interpreter path recorded inside the record being validated — would let a forged record nominate its own authority.
- **Verify later:** if a repository-pinned interpreter path is ever resolved explicitly rather than inherited from `process.execPath`, it must be derived from committed configuration and still cross-checked against the live process, never read from the PID record.

## 2026-08-10 — Readiness deadline widened to 60s on a sixteen-session host, with the failure made self-describing

- **Decision:** `waitForHealth` polls for 60 seconds rather than 30, records every failed attempt to `.dev/logs/health.log`, and its terminal `DEV_HEALTH_DEADLINE` now names the attempt count and every distinct failure reason observed. All lifecycle entry points print the full `cause` chain via `formatErrorChain`.
- **Reason:** one `verify-all` run failed with a bare `DEV_HEALTH_DEADLINE service=preview` immediately after the integration suite's restore, then passed seconds later and in 12 consecutive reruns. The cause was undiagnosable because the message discarded its chain. The widened bound reflects a host shared by sixteen concurrent agent sessions; the gate still fails closed, and no failing check was skipped or quarantined.
- **Verify later:** the root cause is **not** identified. When `DEV_HEALTH_DEADLINE` next occurs, read `.dev/logs/health.log` for the recorded per-attempt reasons and fix that cause rather than widening the bound again. Widening past 60s without a named reason is prohibited.
