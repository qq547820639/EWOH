---
workItemIds: T-138
kind: test
result: passed
commitSha: dee6503effd7c4cea76dbb1d7ce30054d366f0cb
branch: main
buildVersion: 0.6.0-rc4
envFingerprint: 5fe7c6feb11e2726634abc7e27cd90a86f694b21422960b4c3d7f6c71d1facce
dependencyVersion: 3:2.2.5
producedAt: 2026-08-04T05:35:50.594Z
command: "scripts/standalone-check.sh"
suite: http-e2e
startedAt: 2026-08-04T05:35:50.594Z
completedAt: 2026-08-04T05:35:50.594Z
artifactChecksum: 47451a8702be28b3755c7bb9ef42055629dd1afe91384c89a983a50838f10de0
expiresAt: 2026-11-02T05:35:50.594Z
verifier: "EWOH independent verification agent"
---

# Round 54 Evidence - Parameter Registry

Date: 2026-08-03
Scope: Final 5.0 S11 Parameter Registry: typed parameters, scope, source,
validity windows, approval, version history and rollback.

## Implemented

- `ParametersModule` (`/api/parameters/*`, 8 operations) persists org-scoped
  parameters in `ewoh_scheduler_config` under `param.*` keys.
- Supports `number` / `integer` / `string` / `boolean` / `json` data types with
  min/max/enum/pattern validation, unit, factory/work-center/device scope,
  source, effective window, and approval-required lifecycle.
- Parameter lifecycle: `pending -> active -> retired`, versioned updates keep a
  full history, approval gates high-risk changes, and rollback restores the
  previous value with a new version.
- Summary endpoint reports total, status/data-type counts, expired and pending
  approval counts.
- System page adds a Parameter Registry section with registration form,
  inline value updates, approve/rollback/retire actions, and real API wiring.

## Verification

```text
NestJS Jest: 66 suites / 298 tests passed
Client Jest: 6 suites / 22 tests passed
OpenAPI strict audit: 207 controller operations / 207 documented / 0 drift
HTTP + PostgreSQL E2E: 26/26 (includes parameter lifecycle + audit)
Python contract tests: 89 passed
Connector TCK: 17/17 passed
Standalone production build + scripts/standalone-check.sh: PASSED
```

The E2E case registers an approval-required number parameter, approves it,
updates it (creating history), approves the new version, rolls it back, verifies
audit rows are org-scoped, and confirms viewer access is denied.
