---
workItemIds: T-131
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
artifactChecksum: 6b7bf43993c38098f14e5d41b04d9aacf15d7bf1902f295228c8c491df7bd2c2
expiresAt: 2026-11-02T05:35:50.594Z
verifier: "EWOH independent verification agent"
---

# Round 47 Evidence - Stateful Workflow Instances

Date: 2026-08-03
Scope: Y1-06 workflow instance persistence and role-gated advancement.

## Implemented

- `POST/GET /api/workflows/instances` starts and lists org-scoped workflow
  instances persisted in `ewoh_system_config` under `workflow.*` keys.
- `POST /api/workflows/instances/:key/advance` applies role gating, advances
  to an allowed next step, appends history, and writes
  `workflow.instance.advance` audit.
- Unit tests cover start, list, and role-gated advance; E2E starts and
  advances an instance over HTTP.

## Verification

```text
OpenAPI strict audit: 181/181
Workflow instance unit tests: 3 passed
HTTP + PostgreSQL E2E: 23/23 passed including workflow instance lifecycle
```
