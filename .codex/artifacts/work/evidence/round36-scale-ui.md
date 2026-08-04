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
