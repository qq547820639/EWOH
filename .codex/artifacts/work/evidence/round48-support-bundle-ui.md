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
