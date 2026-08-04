---
workItemIds: T-097,T-098
kind: test
result: passed
commitSha: dee6503effd7c4cea76dbb1d7ce30054d366f0cb
branch: main
buildVersion: 0.6.0-rc4
envFingerprint: 5fe7c6feb11e2726634abc7e27cd90a86f694b21422960b4c3d7f6c71d1facce
dependencyVersion: 3:2.2.5
producedAt: 2026-08-04T05:35:50.594Z
expiresAt: 2026-11-02T05:35:50.594Z
verifier: "EWOH independent verification agent"
---

# EWOH Round 15 Evidence - Final 5.0 Adoption and Scale Kernel

Date: 2026-08-03
Scope: Final 5.0 master baseline and template/asset scale kernel.

## Changes Landed

- Final 5.0 `规模化复制版` adopted as master baseline; Final 4.0 kept as
  `authoritative-plan-final4.txt`, Final 5.0 stored in
  `authoritative-plan-final5.txt`, and the docx copied to
  `delivery/01_开发基线/`.
- New scale tables:
  - `ewoh_factory_template`: template id/name/industry/version, inheritance
    chain, lifecycle status, config/manifest JSON, compatibility.
  - `ewoh_factory_profile`: factory profile from a published template.
  - `ewoh_asset_package`: versioned template/connector/scenario/deploy asset
    registry.
- Managed table packaging becomes 51 (48 + 3 scale tables); generator,
  migration, verify, rollback, and Drizzle schema updated.
- `ScaleModule` adds:
  - Template register/list/detail and lifecycle
    `draft -> reviewed -> certified -> published -> deprecated -> retired`.
  - Template install creates a factory profile.
  - Asset package register/list/detail.
- OpenAPI: 9 new scale routes and schemas.

## Verification Results

- NestJS Jest: 52 suites / 209 tests passed.
- HTTP + PostgreSQL E2E: 18/18, including template publish -> install ->
  asset registration with org scoping.
- OpenAPI strict audit: 143/143 documented, 0 unimplemented.
- PostgreSQL verify: 51 managed tables / 51 RLS.
- `npm run lint`: passed.

## Next Steps

- Connector SDK/catalog and scenario pack runtime.
- Second-factory no-fork install drill and factory profile replay.
