# Tier 0 dependency-evidence network threat analysis

**Reviewed:** 2026-08-10  
**Boundary:** `scripts/dependency-maintenance-evidence.mjs` outbound reads from `registry.npmjs.org` and `api.osv.dev`

## Assets and trust boundary

The command sends only the public names and exact versions of direct development dependencies. It sends no credentials, user content, health data, repository contents, local paths, or raw media. npm packuments and OSV responses are untrusted network input. Publisher-supplied repository metadata is provenance to display, not proof of repository ownership. An empty advisory response is a dated observation, never proof that a version is safe or has no vulnerability history.

## Threats and controls

| Threat or failure                          | Required behavior and control                                                                                                                                        |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Redirect to another origin                 | Redirects are refused; only the two literal HTTPS targets are requested.                                                                                             |
| Slow, stalled, or unavailable service      | Each request has a 30-second deadline. Any timeout/network/HTTP failure exits nonzero; cached success is not substituted.                                            |
| Oversized or endless response              | Declared and streamed byte limits are enforced: 64 MiB for a registry packument and 4 MiB per OSV page.                                                              |
| Malformed JSON or schema drift             | JSON and every consumed field are runtime-validated. Parse/schema errors use stable failure codes and retain their cause.                                            |
| Pagination loop/resource exhaustion        | OSV pagination is bounded to 20 pages; dependency requests run with concurrency 3.                                                                                   |
| Ambiguous/prerelease `latest` value        | The evidence accepts npm's `dist-tags.latest` only when it is a non-prerelease exact version with a publication timestamp.                                           |
| Advisory omission or stale aggregator data | The artifact records source, query, snapshot time, returned IDs/aliases/timestamps, and exact-version affected status. Documentation states the residual limitation. |
| Compromised publisher metadata             | Raw and normalized repository fields are retained as publisher-supplied values and are never fetched, executed, or treated as ownership validation.                  |
| Nondeterministic evidence                  | Arrays and object keys are sorted. Check mode reuses the committed snapshot timestamp, repeats the live queries, and byte-compares the result.                       |
| Secret leakage in logs/artifacts           | Requests require no authentication; request bodies contain only public package coordinates. Responses and errors do not include local environment values.            |

## Failure and operational model

This gate intentionally fails closed during registry/OSV outage or drift. Regeneration is explicit through `npm run evidence:dependency-maintenance`; canonical verification invokes its live `--check` path through `npm run check:dependencies`. The repository does not execute downloaded code, follow repository links, mutate the lockfile, or automatically upgrade a dependency from this boundary. A future source, credential, proxy, mirror, or advisory provider requires this analysis and the allowlisted origins to be revised before use.

## Residual risks

- System DNS and the host CA store remain trusted for HTTPS endpoint identity.
- npm and OSV can be incomplete, delayed, or compromised simultaneously.
- Release recency measures publication activity only; it does not measure maintainer responsiveness, code review, support policy, or security quality.
- Live checks reduce reproducibility during a provider outage, by design: lack of current evidence is a red gate rather than a silently accepted stale result.
