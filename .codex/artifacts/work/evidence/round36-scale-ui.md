---
workItemIds: [T-351, T-352, T-353, T-354, T-355, T-356, T-357, T-358, T-359, T-360]
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

# Round 36 Evidence - Scale Operations UI

Date: 2026-08-03
Scope: Frontend command/operations surface for scale productization.

## Implemented

- Added `/scale` route, navigation entry, and `Scale.tsx` page wired to real
  `/api/scale/templates`, `/api/scale/profiles`, `/api/scale/assets`,
  `/api/scale/compatibility`, and `/api/scale/onboarding/run`.
- The page shows template/profile/asset/compatibility summary cards, an asset
  compatibility table, factory profile table, and an F0-F6 onboarding runner.
- Added `client/src/api/scale.ts`, `scaleDashboard` query key, and a
  navigation test for platform roles.

## Verification

```text
Client Jest: 6 suites / 21 tests passed
Standalone production build: passed
Type check + lint: passed
```
