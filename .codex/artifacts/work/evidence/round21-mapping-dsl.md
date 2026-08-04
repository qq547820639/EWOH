---
workItemIds: T-105
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

# Round 21 Evidence - Mapping DSL and Schema Registry

Date: 2026-08-03
Scope: Final 5.0 Y1-04 Mapping DSL and Schema Registry.

## Implemented

- Added `contracts/mapping/mapping-schema.json` as the versioned mapping DSL
  schema (`ewoh:///mapping/v1`), requiring `mappingId`, `name`, `version`,
  `source`, `target`, and non-empty `rules`.
- Added a canonical example `exoskeleton-telemetry.yaml` with 11 rules mapping
  the exoskeleton JSONL frame into the EWOH telemetry schema.
- Added `scripts/audit-mapping-contracts.js` (10 checks), `npm run contract:mapping`,
  and `test/contract/mapping.spec.ts` using AJV validation.
- Added `POST /api/scale/mappings`, `GET /api/scale/mappings`, and
  `GET /api/scale/mappings/:id` backed by the asset package registry; mapping
  assets carry `mappingSchemaVersion: v1` in their manifest.
- Extended the asset TCK with mapping conformance checks for source/target
  schema refs, non-empty rules, rule paths, and schema version.
- E2E registers a mapping, lists/detail-fetches it, runs conformance, and
  verifies org scoping in PostgreSQL.

## Verification

```text
Mapping contract audit: schema ewoh:///mapping/v1 | example exoskeleton-telemetry-v1 1.0.0 | 11 rules | 10 checks passed
OpenAPI strict audit: 158/158
Scale unit tests + mapping contract tests: passed
HTTP + PostgreSQL E2E: 19/19 passed including mapping register/conformance
```
