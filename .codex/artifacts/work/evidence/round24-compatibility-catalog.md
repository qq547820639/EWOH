# Round 24 Evidence - Compatibility Catalog

Date: 2026-08-03
Scope: Final 5.0 Y4-07 compatibility catalog release.

## Implemented

- Added `server/modules/scale/compatibility.ts` with semver-like version
  parsing, prerelease ordering, and `matchesCoreRange` support for `>=`, `<=`,
  `>`, `<`, `=` and space-separated AND ranges.
- `GET /api/scale/compatibility` returns the org asset/core compatibility
  matrix: core version, compatible/incompatible counts, and per-asset range,
  compatibility, and reason.
- Ranges are read from `compatibleCore`, `compatibility.core`, or
  `requires.core` depending on package type; unconstrained packages are marked
  compatible with reason `unconstrained`.
- Unit tests cover version parsing, range matching, prerelease ordering, and
  catalog aggregation. E2E registers a legacy connector with an incompatible
  core range and verifies the catalog marks it incompatible.

## Verification

```text
OpenAPI strict audit: 161/161
Compatibility unit tests: passed
HTTP + PostgreSQL E2E: 20/20 passed including compatibility catalog
```
