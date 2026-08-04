---
workItemIds: T-183
kind: test
result: passed
commitSha: dee6503effd7c4cea76dbb1d7ce30054d366f0cb
branch: main
buildVersion: 0.6.0-rc4
envFingerprint: 5fe7c6feb11e2726634abc7e27cd90a86f694b21422960b4c3d7f6c71d1facce
dependencyVersion: 3:2.2.5
producedAt: 2026-08-04T05:35:50.594Z
command: "npm run test:e2e"
suite: http-e2e
startedAt: 2026-08-04T05:35:50.594Z
completedAt: 2026-08-04T05:35:50.594Z
artifactChecksum: 6e82c83d67cb2a339e25f4dc15e4632b35f88af323eb97c6b96694f15b371f85
expiresAt: 2026-11-02T05:35:50.594Z
verifier: "EWOH independent verification agent"
---

# Round 75 - 2026-08-04 Real PostgreSQL HTTP E2E

Branch: `codex/ewoh-iteration-2026-08-04`

## Real command evidence

```text
EWOH_E2E_RUNTIME_DATABASE_URL='postgresql://ewoh_api:ewoh-runtime-test-only-2026@127.0.0.1:55432/postgres' npm run test:e2e

Test Suites: 1 passed, 1 total
Tests:       29 passed, 29 total
```

Environment: embedded PostgreSQL 17 listening on `127.0.0.1:55432`.

## Covered scenarios

- Health/readiness and Prometheus metrics with factory resource attributes.
- Unauthenticated 401, RBAC role denial, and device route roles.
- Event catalog, policy evaluation, workflow role-aware next steps.
- System config, feature flags, parameter registry, AAS assets, request traces.
- Refresh token rotation/logout and org A/B control isolation.
- World snapshot/cursor expiry, control persistence, canonical ingestion,
  gamification allocation, MES work order/material/quality trace.
- OEE/andon SLA, ERP idempotent inbound/outbound, factory template/profile/
  asset package install, approvals, scheduler idempotency, org-scoped config,
  operations lifecycle, and work orchestration role gating.

## Impact

- Local E2E gap is now closed; `G8` updated to `Passed locally`.
- Standalone gate remains `ALL STANDALONE CHECKS PASSED` and now has a real
  PostgreSQL-backed acceptance run alongside it.
