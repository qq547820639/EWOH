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
