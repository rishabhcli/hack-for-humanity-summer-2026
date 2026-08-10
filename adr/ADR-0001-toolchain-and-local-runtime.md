# ADR-0001: TypeScript web toolchain and isolated local runtime

- **Status:** Accepted
- **Date:** 2026-08-09
- **Scope:** Tier 0 executable contract

## Context

The repository must build a static, local-processing PWA while keeping domain code independent from UI and external providers. The first executable slice also has to run beside fifteen sibling repositories without using a framework default port or an unowned process. The repository began with no package boundary, lockfile, source, tests, CI, or local service contract.

The reference runtime must avoid Node 24.18.0 because the July 2026 Node security release requires a patched 24.x release. TypeScript 7.0 is not compatible with the supported range of the selected type-aware ESLint tooling. Vite 8 was released only days before this decision and would introduce a second new build-engine surface without a product benefit.

## Decision

1. Use Node 24.19.0 as the CI/reference runtime and npm 11.17.0 as the package manager. Local development accepts patched Node versions `>=24.19.0 <27`; browser-facing types are pinned to the Node 24 API surface.
2. Use exact package versions and npm lockfile v3. Lifecycle scripts are denied unless listed in `package.json#allowScripts`; esbuild's exact postinstall is allowed because Vite requires its verified platform binary, while optional fsevents scripts are denied.
3. Use TypeScript 6.0, Vite 7, and a vanilla TypeScript composition root. Do not add a component framework until a real interaction surface demonstrates that its operational cost is justified.
4. Use `vite-plugin-pwa` to create the installable artifact. Its service-worker behavior is shipped behavior and must be tested for install, offline use, update, and stale-cache failure before a release gate can pass.
5. Use Vitest for unit tests, fast-check for seeded property tests, and Playwright Chromium for browser tests. Playwright uses fresh repository-local persistent profiles under `.dev/pw-profile/`, installs its exact declared browser revision under `.dev/cache/ms-playwright/`, and grants its self-signed development certificate an SPKI-scoped browser exception rather than a global certificate bypass.
6. Split browser, tool, and checked-JavaScript configurations. Browser code and every repository-owned JavaScript file, including script tests, keep `skipLibCheck: false`. The TypeScript-only tool configuration isolates declaration defects in Workbox and optional `vite-plugin-pwa` modules with `skipLibCheck: true`; this skips only dependency declaration checking, not repository tool sources.
7. Use repository-owned HTTPS services on `127.0.0.1:4180-4183`. Generate an ignored development certificate, pin it in readiness probes, authenticate readiness with a per-process HMAC challenge, and record only owned PIDs.
8. Keep browser assets self-contained. The application may not fetch external fonts, analytics, or runtime assets.
9. Make `npm run bootstrap` followed by `npm run verify-all` the clean-checkout contract. Bootstrap owns the frozen dependency install and exact Playwright Chromium install; `verify-all` owns the ordered verification and lifecycle/browser gates.
10. Force npm's cache, Playwright browser binaries, Vite caches, logs, PID records, profiles, certificates, and scratch files into the ignored repository-local `.dev/` tree. The command contract must not depend on or mutate a sibling repository's caches.
11. Treat planned domain paths as policy-owned names, not scaffolding requirements. Do not create a physical domain directory until it contains working production code with its tests and documentation.

## Alternatives considered

- **TypeScript 7:** rejected until typescript-eslint supports it.
- **Vite 8:** rejected for this epoch because its release and Rolldown surface are too new; an upgrade can be a later dependency ratchet with before/after evidence.
- **React or another UI framework:** rejected for the foundation because the current truthful readiness surface does not need framework state.
- **pnpm:** rejected for Tier 0 because the host home directory is already an unrelated pnpm workspace; npm provides a clearer repository-local boundary here.
- **HTTP localhost:** rejected because the repository contract explicitly requires HTTPS and camera work must exercise secure-context behavior.
- **Disabling TLS verification:** rejected because a foreign process could spoof a static health response.

## Consequences

- `npm run bootstrap` followed by `npm run verify-all` is the reproducible clean-checkout command surface; calling `npm ci` alone does not install the repository-scoped browser revision or prove the verification gates.
- npm, Vite, and Playwright caches are repository-scoped under `.dev/cache/`; bootstrap includes the browser binary needed by the E2E contract, and repository commands override inherited npm cache configuration.
- The boundary checker can reserve and enforce an ownership area before that area exists on disk; a missing planned domain directory means no implementation has been claimed.
- The local lifecycle currently supports macOS/Linux hosts with `lsof`, `ps`, and OpenSSL; unsupported hosts fail during preflight rather than binding unsafely.
- The PWA dependency adds Workbox and supply-chain/runtime behavior that remains part of later security, offline, update, and cache verification.
- A framework or toolchain replacement requires a new ADR, dependency review, migration plan, and clean-checkout comparison.

## Reversal

Replace the build/test dependencies behind the same package-script and port contracts, regenerate `package-lock.json` and dependency evidence, run `npm run bootstrap` and then `npm run verify-all` from a clean checkout, and compare the built artifact, PWA behavior, browser workflow, bundle size, and lifecycle safety before removing this stack.
