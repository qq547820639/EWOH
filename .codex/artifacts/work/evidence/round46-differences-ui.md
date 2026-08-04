# Round 46 Evidence - Factory Differences UI

Date: 2026-08-03
Scope: Frontend operations for factory difference recycling.

## Implemented

- Added `listFactoryDifferences`, `registerFactoryDifference`, and
  `resolveFactoryDifference` to the client scale API module.
- The `/scale` page now has a factory differences section with a registration
  form, status badges, and per-row resolve action.
- Added `scaleDifferences` query key; client typecheck, lint, tests, and
  standalone production build pass.

## Verification

```text
Client Jest: 6 suites / 21 tests passed
Standalone production build: passed
Type check + lint: passed
```
