---
workItemIds: T-060,T-084,T-085
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

# EWOH Round 6 Evidence - Ingestion Protocol Alignment

Date: 2026-08-03
Scope: canonical UnifiedExoFrame ingestion contract, M2M tenant context, and
gamification persistence verification.

## Defects Found

- The NestJS ingestion API required flat `device_id` / `pitch_deg` /
  `load_score` fields, while `UnifiedExoFrame.to_storage_dict()` emits
  `entity_id` plus nested `pose` / `load` / `device` / `quality` groups.
  Real adapter frames would have failed with 400.
- Public ingestion endpoints had no request tenant context, so entity lookup
  and RLS writes ran without `app.current_org_id` and could not persist.
- `ewoh_telemetry.assist_level` was declared `varchar(50)` while the contract
  and Python adapter produce a numeric 0-1 assist level.

## Changes Landed

- `shared/api.interface.ts`: `entity_id` is the canonical required field,
  `device_id` remains a compatibility alias, and nested canonical groups plus
  numeric `assist_level` are supported.
- `server/modules/ingest`: controller accepts `entity_id` or `device_id`;
  service maps nested pose/load/device/quality fields; `X-Org-Id` header or
  `EWOH_INGEST_ORG_ID` establishes the M2M request GUC context.
- DDL: `assist_level real` in generator, `schema.ts`, and regenerated
  standalone/non-standalone migrations.
- Python bridge and modeling scripts now emit canonical fields and forward
  `X-Org-Id`.

## Verification Results

- NestJS Jest: 44 suites / 176 tests passed.
- HTTP + PostgreSQL E2E: 14/14 passed, including canonical ingestion, raw-ref
  idempotency, source_type/org isolation, and gamification allocation audit
  persistence.
- Repo pytest: 59 passed.
- Python unittest: 667 passed.
- `scripts/standalone-postgres-check.sh`: PASS (48 managed tables, 48 RLS,
  rollback to zero objects, rebuild, security probe).
- `npm run lint`: passed.
- `npm run build:prod:standalone`: passed.
- OpenAPI strict route audit: 107/107 documented, 0 unimplemented.
- `scripts/release-drill.sh`: `RELEASE DRILL PASSED` on disposable PostgreSQL
  17; the drill now defaults `EWOH_E2E_OWNER_DATABASE_URL` to
  `EWOH_DATABASE_URL` so E2E fixtures are created in the same database as the
  migrated schema.
