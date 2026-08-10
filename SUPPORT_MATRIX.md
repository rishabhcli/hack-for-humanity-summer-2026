# Support matrix

> **Status audited:** 2026-08-10. The repository is not yet in production. No camera, device, or
> measurement configuration is validated. See the latest [PROGRESS.md](./PROGRESS.md) entry before
> treating an executable-foundation row as currently verified.

## User-facing measurement support

| Surface                                  | Supported                 | Current behavior outside support           |
| ---------------------------------------- | ------------------------- | ------------------------------------------ |
| Head-reposition measurement              | No                        | No measurement control or value is exposed |
| Camera devices                           | None validated            | Measurement is withheld                    |
| Distance, lighting, occlusion, yaw, roll | None validated            | Measurement is withheld                    |
| Clinical thresholds                      | None reviewed for display | No threshold is displayed                  |
| Session comparison                       | No                        | No improvement claim is produced           |

## Executable foundation support

| Surface                | Status                                                        | Evidence / limitation                                                                  |
| ---------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Node.js                | Reference 24.19.0; local compatibility `>=24.19.0 <27`        | `.node-version`, package engines, and `typecheck`                                      |
| npm                    | Exactly 11.17.0                                               | `packageManager`, `devEngines`, strict lifecycle allowlist, and lockfile               |
| Local host binding     | `127.0.0.1` only                                              | `dev:preflight`, authenticated `dev:health`, integration test                          |
| Local ports            | 4180 PWA, 4181 preview, 4182 Playwright, 4183 fixture service | `ports.env`; every other port is refused                                               |
| Local TLS              | Repository-generated, ignored development certificate         | Readiness pins the certificate; not a public trust chain                               |
| Local OS tooling       | macOS/Linux with `lsof`, `ps`, OpenSSL, Node, npm             | Preflight fails when a required tool is absent; Windows is not supported yet           |
| Browser test           | Playwright Chromium 151.0.7922.34, revision 1234              | Exact revision is in dependency evidence; other engines/devices unverified             |
| Fixture corpus         | Manifest schema only; zero validated media                    | Readiness reports `corpusReady: false`                                                 |
| PWA surface            | Local prerequisite/readiness shell only                       | Does not request camera permission, process frames, or measure head position           |
| Canonical verification | Red at `check:build` on commit `e9e7070`                      | Stale build evidence blocks Tier 0 exit; later integration/E2E steps did not run in CI |

Every added support claim requires a regenerating command and evidence. Unsupported configurations must continue to withhold measurement rather than estimate optimistically.
