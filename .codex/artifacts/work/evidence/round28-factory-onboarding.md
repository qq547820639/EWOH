---
workItemIds: [T-271, T-272, T-273, T-274, T-275, T-276, T-277, T-278, T-279, T-280]
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
