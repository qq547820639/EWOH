---
workItemIds: [T-411, T-412, T-413, T-414, T-415, T-416, T-417, T-418, T-419, T-420]
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

# Round 42 Evidence - Third Factory Config-Driven Drill

Date: 2026-08-03
Scope: Final 5.0 Y4-03 third factory config-driven validation.

## Implemented

- E2E now installs a third factory profile from the same published template
  using only config (`shift.count=4`, `upgradeRing=small`), proving no code
  fork or second template is required.
- The test verifies a distinct profile row, `installed` status, persisted
  config, and org scoping in PostgreSQL.

## Verification

```text
HTTP + PostgreSQL E2E: 23/23 passed including third factory config install
Third profile row: installed, config shift.count=4, upgradeRing=small, org A
```
