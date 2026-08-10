# Hack for Humanity | Summer 2026

> A privacy-preserving webcam joint-position-error measurement and training system with explicit repeatability and uncertainty.

> **Production intent:** this repository is for the complete, reliable system described below. It is not an MVP, disposable demo, or thin hackathon facade. No product name has been assigned; the hackathon title remains the repository heading until the user chooses one.

## Repository status

The Tier 0 executable foundation is under active implementation. A truthful browser-readiness surface and the repository-isolated HTTPS development lifecycle exist, but camera measurement, calibration, the protocol, validation fixtures, and every production release gate remain unimplemented. The repository is **not yet in production**.

| Document | Authority |
|---|---|
| [HACKATHON.md](./HACKATHON.md) | Eligibility, mandatory submission fields, judging criteria, deadlines, links |
| [WINNING_IDEA.md](./WINNING_IDEA.md) | Selected concept, hard technical core, validation, build order, demo and risk analysis |
| [README.md](./README.md) | Product contract, architecture, production and release expectations |
| [AGENTS.md](./AGENTS.md) | Binding implementation rules for every coding agent working in this repository |

If these documents disagree, preserve the external requirements in HACKATHON.md, then the product intent in WINNING_IDEA.md, and resolve the conflict explicitly in an ADR instead of guessing.

## Product contract

Deliver a production-grade, non-diagnostic measurement tool that guides a standardized eyes-closed head repositioning protocol, rejects poor camera/body geometry, estimates angular return error with uncertainty, measures test-retest repeatability, and shows whether observed improvement exceeds measurement noise.

### Intended users

- People completing clinician-guided cervical proprioception exercises
- Rehabilitation professionals reviewing session evidence
- Researchers validating low-cost joint-position measurement

### Canonical workflow

1. Calibrate camera, seating geometry, neutral pose, and quality
2. Guide standardized rotations and eyes-closed return attempts
3. Estimate head pose while rejecting torso/camera motion and low confidence
4. Compute directional absolute error and trial reliability
5. Run a bounded training block
6. Repeat the measurement and compare change against measurement error
7. Export a clinician-readable report without diagnosing cause or recovery

### Explicit non-goals

- Concussion diagnosis, clearance, triage, or treatment recommendation
- Replacing a clinician or calibrated research instrument
- Generic posture notifications
- Cloud video storage
- Claiming improvement from one noisy trial

A non-goal may become part of the product only after the core release gates pass and an ADR explains why the additional surface does not weaken correctness, safety, usability, or schedule.

## Production architecture

Static/local processing; raw camera frames never leave the device. Production support is limited to a tested camera/distance/lighting matrix and refuses measurements outside it.

### Planned component boundaries

| Area | Production responsibility |
|---|---|
| `src/protocol` | Standardized calibration, trials, rotations, rests, training |
| `src/vision` | Landmarks, head/torso/camera motion, pose confidence |
| `src/measurement` | Neutral reference, angular error, repeatability, uncertainty |
| `src/quality` | Distance, lighting, occlusion, yaw/roll limits, refusal |
| `src/report` | Session comparison, method, limitations, export |
| `src/ui-accessibility` | Instructions, audio/visual cues, keyboard, reduced motion |
| `validation` | Known-angle rigs/videos, device matrix, test-retest study |

Dependencies should flow from applications/adapters toward typed domain packages. Domain logic must remain testable without UI, network, cloud credentials, or third-party services. Infrastructure code may assemble components but must not become the only place where product invariants are enforced.

### Target technology foundation

- TypeScript web app/PWA with WebRTC
- MediaPipe/face-landmark or equivalent local pose estimation
- WebGL/Canvas protocol UI
- Local statistical analysis and encrypted/session-only storage
- Vitest, Playwright, prerecorded geometry fixtures, device validation

Technology choices are constraints, not decorations. A dependency is accepted only when its operational behavior, license, failure modes, supply-chain risk, and replacement boundary are understood.

## Non-negotiable invariants

1. The system never outputs a diagnosis or return-to-activity decision
2. A measurement is withheld when geometry or pose confidence fails
3. Improvement is reported only relative to declared measurement error/repeatability
4. Neutral reference and calibration are versioned per session
5. Camera/torso movement is separated from intended head rotation or the trial is rejected
6. Raw frames are not transmitted or retained by default
7. All clinical thresholds require an authoritative citation and review before display

Any change that can violate an invariant requires a written design review, tests demonstrating preservation under failure, and an explicit update to this README and AGENTS.md.

## Security, privacy, and safety

- Prominent stop/seek-care language for concerning symptoms without triage automation
- No health analytics or advertising
- Session export is explicit and contains method/limitations
- Use synthetic/consented recordings in repository and demo

Common controls required across the system:

- secrets come from an approved secret store or local ignored environment file and are never committed, rendered, or logged;
- untrusted files, prompts, provider output, repository content, and external responses are treated as data, never instructions;
- authorization is enforced at the data/action boundary, not only in the UI;
- logs, traces, fixtures, screenshots, and demo assets are scrubbed of credentials and sensitive user data;
- destructive or externally visible actions are previewable, idempotent where possible, auditable, and fail closed;
- dependency and container scanning, lockfiles, least privilege, and an incident/rollback path are release requirements.

## Reliability and operations

Production behavior includes failures, retries, restarts, partial responses, stale data, duplicate delivery, and resource exhaustion. The implementation must therefore provide:

- typed error classes and user-visible failure states rather than catch-all success fallbacks;
- bounded timeouts, cancellation, retry budgets, and backoff for every external or long-running operation;
- idempotency and reconciliation wherever the same work may be delivered twice or its external outcome may be unknown;
- structured, redacted logs; metrics for throughput, latency, error and abstention/refusal; and traces across meaningful boundaries;
- health/readiness checks that validate dependencies without mutating user data;
- documented SLOs and alerts before public production use;
- backup, restore, migration, retention, and cleanup procedures for every persistent store;
- graceful degradation that preserves truth and safety before convenience or visual effects.

## Verification strategy

Project-specific required test surfaces:

- Known-angle/head-pose calibration fixtures
- Camera distance, yaw/roll, lighting, occlusion and torso-motion rejection
- Repeatability, standard error, minimal detectable change
- Cross-device/browser behavior
- Protocol timing and incomplete-session recovery
- Accessibility, privacy/no-network, and unsafe-copy review

Every production path also needs unit tests, property or fuzz tests where state space matters, integration tests at real boundaries, end-to-end tests of the user outcome, accessibility checks, performance budgets, security regression tests, and failure-injection coverage. Mocks belong in test fixtures; the shipped runtime must not depend on a fake service or hardcoded winning example.

Evaluation datasets and fixtures are versioned, provenance-aware, and isolated from tuning when described as held out. A number may appear in the README or submission only when a committed script regenerates it from a committed manifest.

## Performance and accessibility

Performance budgets must be set before optimization and enforced in CI for supported environments. Measure latency distributions, memory, CPU/GPU, network or storage volume, cold start, cancellation, and degraded-device behavior relevant to this product. Do not replace measurements with “feels fast.”

Accessibility is a release gate, not a polish task. The production interface must include semantic structure, keyboard support, visible focus, sufficient contrast, non-color status cues, reduced-motion behavior where relevant, zoom/reflow, readable errors, and an equivalent representation for information conveyed through canvas, charts, audio, maps, camera, or animation.

## Planned repository layout

```text
/
├── README.md                 # Product and operating contract
├── AGENTS.md                 # Binding implementation rules for coding agents
├── HACKATHON.md              # External rules and submission facts
├── WINNING_IDEA.md           # Selected product/technical blueprint
├── src/protocol/
├── src/vision/
├── src/measurement/
├── src/quality/
├── src/report/
├── src/ui-accessibility/
├── validation/
├── tests/                    # Unit, property, integration, E2E, resilience
├── adr/                      # Numbered architecture decisions
├── docs/                     # Threat models, runbooks, dependency and evaluation records
└── infra/                    # Reproducible deployment and environment policy
```

This is a boundary contract, not a command to create empty directories. Add a directory when it owns working code, tests, and documentation.

The committed boundary policy treats the names in this layout as reserved ownership areas even before their directories exist. This is intentional: `src/protocol`, `src/vision`, `src/measurement`, `src/quality`, and `src/report` remain absent until a production slice supplies real owned code. Empty directories or placeholder files would not satisfy Tier 0 or Tier 6.

## Development command contract

The checked-in npm scripts and Makefile expose the command surface below. `eval` and `release-check` currently fail closed with stable refusal codes because there is no validated fixture corpus, measurement oracle, or green release-gate evidence; they must not be interpreted as passing commands yet.

| Command | Required behavior |
|---|---|
| `bootstrap` | Verify tool versions, install locked dependencies, initialize only local non-secret state |
| `format` | Check committed files against the repository Prettier policy without rewriting them |
| `lint` | Run static lint plus source-ownership, import-boundary, and cycle checks |
| `typecheck` | Type-check browser, tooling, and checked JavaScript configurations without emitting files |
| `check` | Format check, lint, type/static analysis, schema/config validation |
| `test` | Deterministic unit and property suites |
| `test-integration` | Real boundary tests using isolated local/test dependencies |
| `test-e2e` | Supported user workflows and failure states |
| `eval` | Reproduce committed domain evaluation and metrics |
| `build` | Produce release artifacts from a clean checkout |
| `run-local` | Start the complete local system or a documented production-equivalent subset |
| `verify-all` | Run the canonical ordered local verification pipeline, including lifecycle and browser checks |
| `release-check` | Run all blocking gates, artifact/SBOM generation, and policy checks |

A new contributor should be able to move from a clean checkout to a verified local system without tribal knowledge.

### Clean-checkout verification

Use Node.js `24.19.0` and its bundled npm `11.17.0`; both are checked before npm runs a repository script. The local lifecycle also requires `git`, `lsof`, and OpenSSL on macOS or Linux. Then run:

```sh
npm run bootstrap
npm run verify-all
```

`bootstrap` performs a frozen `npm ci` and installs the Playwright Chromium revision declared by the exact Playwright package. `verify-all` already runs preflight, starts and health-checks the local cohort, and exercises the browser workflow after the static, dependency, unit, integration, and build checks; duplicating those lifecycle commands is not part of the clean-checkout recipe. npm, Vite, and browser caches stay under the ignored `.dev/cache/` tree.

The committed allocation is HTTPS `127.0.0.1:4180-4183`, inside this repository's exclusive `4180-4189` block. Runtime relocation is prohibited. Any approved allocation change is a synchronized contract change: update `ports.env`, the lifecycle and Playwright configuration/tests, `ASSUMPTIONS.md`, ADR-0002, and clean-checkout evidence together. Stop owned services with `npm run dev:down`; never use a broad process-kill command.

## Environment model

- **Local:** isolated developer data, safe fixtures, no real-world side effects by default.
- **Test:** deterministic automated environment with controlled boundary services.
- **Staging:** production-shaped deployment, synthetic/de-identified data, real observability and rollback.
- **Production:** least-privilege credentials, audited configuration, SLOs, incident ownership, backups and change controls.

Configuration is typed, validated at startup, documented, and separated from secrets. Environment-specific branches or code paths are prohibited; behavior changes through validated configuration and capability boundaries.

## Release gates

1. Known-angle error and repeatability targets met on supported matrix
2. Poor-quality trials fail closed
3. Change claims use validated uncertainty
4. Privacy/no-frame-upload tests pass
5. Clinical copy/source review completed or prototype limitation explicit
6. End-to-end protocol and accessible report pass user testing

Common blocking gates also include:

- clean build from a fresh checkout with locked dependencies;
- no critical/high unresolved security findings and no committed secrets;
- migration/rollback and backup/restore rehearsal where state exists;
- passing accessibility and supported-environment matrix;
- complete observability, runbook, known-limitations, privacy, and threat-model documentation;
- no placeholder copy, dead controls, fake metrics, hardcoded demo results, or production TODO paths;
- submission assets and claims generated from the same tested release commit.

## Production milestone policy

Work proceeds in complete vertical slices, but every merged slice must use the final architecture, schemas, security boundaries, telemetry, error model, tests, and documentation expected in production. A smaller completed surface is acceptable; a throwaway implementation that will be replaced later is not.

A feature is not complete when it works once. It is complete when supported inputs, invalid inputs, retries, cancellation, restart, privacy, accessibility, observability, performance, deployment, rollback, and documentation are all accounted for.

## Hackathon delivery

HACKATHON.md contains the live form links and exact requirements. WINNING_IDEA.md contains the selected demo and judging strategy. Production engineering must strengthen that submission, not create a separate demo path. The video, screenshots, hosted build, evaluation numbers, and repository documentation must all describe the same release artifact.

## Contributing

Read AGENTS.md before changing code. Keep changes narrowly scoped, add or update tests with behavior, record architecture/security decisions in ADRs, and never weaken an invariant to make a demo pass. No product name, logo, pricing claim, medical/legal claim, partner claim, or benchmark result should be invented without explicit evidence and user approval.
