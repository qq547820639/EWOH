---
workItemIds: T-108
kind: test
result: passed
commitSha: dee6503effd7c4cea76dbb1d7ce30054d366f0cb
branch: main
buildVersion: 0.6.0-rc4
envFingerprint: 5fe7c6feb11e2726634abc7e27cd90a86f694b21422960b4c3d7f6c71d1facce
dependencyVersion: 3:2.2.5
producedAt: 2026-08-04T05:35:50.594Z
command: "npm run test:e2e"
suite: http-e2e
startedAt: 2026-08-04T05:35:50.594Z
completedAt: 2026-08-04T05:35:50.594Z
artifactChecksum: 1eb98d78352004dfdc025a73cd22b6e88dc9f640b82d71222dbbc2a5592d967e
expiresAt: 2026-11-02T05:35:50.594Z
verifier: "EWOH independent verification agent"
---

# Round 24 Evidence - Compatibility Catalog

Date: 2026-08-03
Scope: Final 5.0 Y4-07 compatibility catalog release.

## Implemented

- Added `server/modules/scale/compatibility.ts` with semver-like version
  parsing, prerelease ordering, and `matchesCoreRange` support for `>=`, `<=`,
  `>`, `<`, `=` and space-separated AND ranges.
- `GET /api/scale/compatibility` returns the org asset/core compatibility
  matrix: core version, compatible/incompatible counts, and per-asset range,
  compatibility, and reason.
- Ranges are read from `compatibleCore`, `compatibility.core`, or
  `requires.core` depending on package type; unconstrained packages are marked
  compatible with reason `unconstrained`.
- Unit tests cover version parsing, range matching, prerelease ordering, and
  catalog aggregation. E2E registers a legacy connector with an incompatible
  core range and verifies the catalog marks it incompatible.

## Verification

```text
OpenAPI strict audit: 161/161
Compatibility unit tests: passed
HTTP + PostgreSQL E2E: 20/20 passed including compatibility catalog
```
