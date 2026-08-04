# Round 28 Evidence - Factory Onboarding

Date: 2026-08-03
Scope: Final 5.0 S19/Y4-01 single-factory standard import.

## Implemented

- `GET /api/scale/onboarding/checklist` returns the machine-readable F0-F6
  onboarding steps.
- `POST /api/scale/onboarding/run` executes real onboarding operations:
  profile selection, template publish, connector packages, TCK-gated scenario
  packs, profile install, asset conformance, and support/evidence bundle.
- Each step records `passed`, `detail`, `durationMs`, and optional data; the
  run writes a `scale.onboarding.run` audit entry.
- Unit tests cover checklist shape, successful run, and failed template
  install; E2E runs onboarding over HTTP and verifies the installed profile in
  PostgreSQL.

## Verification

```text
OpenAPI strict audit: 166/166
Onboarding unit tests: 3 passed
HTTP + PostgreSQL E2E: 21/21 passed including onboarding run
```
