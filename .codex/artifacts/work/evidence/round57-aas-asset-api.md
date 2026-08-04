---
workItemIds: [T-561, T-562, T-563, T-564, T-565, T-566, T-567, T-568, T-569, T-570]
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

# Round 57 Evidence - AAS Asset Registry API + Data Assets UI

Date: 2026-08-03
Scope: Productize AAS/IEC 63278 exchange: org-scoped AAS asset import/list/
detail/twin-semantics API and a Data Assets UI section.

## Implemented

- `AasModule` (`/api/aas/assets`, 4 operations) persists AAS assets in
  `ewoh_scheduler_config` under `aas.*` with RLS org isolation and audit.
- Import validates asset ID, submodel IDs, element `idShort`, and supported
  value types (`string/integer/number/boolean/dateTime/json`).
- `GET /api/aas/assets/:assetId/semantics` returns the EWOH twin semantic
  mapping (semantics list + typed properties).
- Data Assets page adds an AAS 资产壳 section: import form, asset table,
  and per-asset semantic mapping viewer.

## Verification

```text
NestJS Jest: 67 suites / 302 tests passed
Client Jest: 6 suites / 22 tests passed
OpenAPI strict audit: 211 controller operations / 211 documented / 0 drift
HTTP + PostgreSQL E2E: 27/27 (includes AAS import/list/detail/semantics/audit)
Python contract tests: 107 passed
Rego TCK: 4/4 passed
scripts/standalone-check.sh: ALL STANDALONE CHECKS PASSED
```

The E2E case imports an AAS asset, verifies list/detail/semantics, confirms
audit row org scoping, and denies viewer access.
