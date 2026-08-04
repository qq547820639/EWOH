---
workItemIds: [T-471, T-472, T-473, T-474, T-475, T-476, T-477, T-478, T-479, T-480]
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

# Round 48 Evidence - Support Bundle UI

Date: 2026-08-03
Scope: Frontend operation for redacted fleet diagnostic bundles.

## Implemented

- Added `generateSupportBundle` to the client scale API module.
- The `/scale` page now has a one-click "生成诊断包" action which calls
  `POST /api/scale/fleet/support-bundle` and shows bundle id, factory count,
  and `includesSecrets` status.
- Client typecheck, lint, tests, and standalone production build pass.

## Verification

```text
Client Jest: 6 suites / 21 tests passed
Standalone production build: passed
Type check + lint: passed
```
