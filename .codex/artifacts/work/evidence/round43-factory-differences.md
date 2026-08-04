---
workItemIds: [T-421, T-422, T-423, T-424, T-425, T-426, T-427, T-428, T-429, T-430]
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

# Round 43 Evidence - Factory Difference Recycling

Date: 2026-08-03
Scope: Final 5.0 Y4-02 difference recycling and platformization.

## Implemented

- `POST /api/scale/differences` registers a factory-specific difference in
  `ewoh_system_config` under `diff.<factory>.<key>` with category/value/status
  metadata and a `scale.difference.register` audit entry.
- `GET /api/scale/differences` lists org-scoped differences with update
  metadata.
- Unit tests cover registration upsert/audit and listing; E2E registers and
  lists a difference over HTTP.

## Verification

```text
OpenAPI strict audit: 177/177
Scale unit tests: difference register/list passed
HTTP + PostgreSQL E2E: 23/23 passed including difference registry
```
