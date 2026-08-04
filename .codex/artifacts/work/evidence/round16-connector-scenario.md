---
workItemIds: T-099
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
artifactChecksum: 1bd94d7a036196d97f41750ee430bf30f0bfd874d9cf9e7031f75f5445f46fb2
expiresAt: 2026-11-02T05:35:50.594Z
verifier: "EWOH independent verification agent"
---

# EWOH Round 16 Evidence - Connector and Scenario Pack Catalog

Date: 2026-08-03
Scope: Final 5.0 connector catalog and scenario pack registration on the
asset package registry, plus second-factory no-fork install drill.

## Changes Landed

- `ScaleService` now registers connectors with runtime/protocol/configSchema/
  compatibility manifest fields and scenario packs with requires/workflows/
  policies/acceptance manifest fields, both stored in `ewoh_asset_package`.
- New routes:
  - `POST /api/scale/connectors`, `GET /api/scale/connectors`
  - `POST /api/scale/scenario-packs`, `GET /api/scale/scenario-packs`
- E2E scale scenario now installs the same published template twice
  (factory B and factory C) to demonstrate second-factory install without a
  code fork.

## Verification Results

- NestJS Jest: 52 suites / 211 tests passed.
- HTTP + PostgreSQL E2E: 18/18, including connector/scenario registration and
  two profiles from one template.
- OpenAPI strict audit: 147/147 documented, 0 unimplemented.
- `npm run lint`: passed.
- `RELEASE DRILL PASSED`.

## Next Steps

- Connector conformance TCK and scenario pack installer.
- Factory profile replay/upgrade drill.
