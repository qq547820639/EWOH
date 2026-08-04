---
workItemIds: T-100
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
artifactChecksum: 6379e851d8bfaa18909b0b2376d7e2a741f4ed2d3e18fcbf35e8e102574dbc00
expiresAt: 2026-11-02T05:35:50.594Z
verifier: "EWOH independent verification agent"
---

# EWOH Round 17 Evidence - Conformance TCK and Factory Profile Replay

Date: 2026-08-03
Scope: Final 5.0 asset conformance checks and factory profile replay/upgrade.

## Changes Landed

- `POST /api/scale/assets/{id}/conformance` runs package-type checks:
  connector runtime/protocol/configSchema/compatibility/outputEvents,
  scenario requires/workflows/policies/acceptance, template modules/
  scenarioPacks, deploy compatibleCore/config, plus semver-like version.
- `POST /api/scale/profiles/{id}/replay` merges template config with profile
  overrides, sets status to `replayed`, updates installed time, and audits.
- OpenAPI: 2 new routes and schemas.

## Verification Results

- NestJS Jest: 52 suites / 213 tests passed.
- HTTP + PostgreSQL E2E: 18/18, including conformance pass on a connector
  package and profile replay with merged config.
- OpenAPI strict audit: 149/149 documented, 0 unimplemented.
- `npm run lint`: passed.
- `RELEASE DRILL PASSED`.

## Next Steps

- Scenario pack installer and fleet upgrade/rollback drill.
- Partner shadow delivery and compatibility directory.
