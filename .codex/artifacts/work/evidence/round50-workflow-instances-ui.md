---
workItemIds: [T-491, T-492, T-493, T-494, T-495, T-496, T-497, T-498, T-499, T-500]
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

# Round 50 Evidence - Workflow Instances UI

Date: 2026-08-03
Scope: Frontend operations for stateful workflow instances.

## Implemented

- Added client APIs for workflow example, instance list/start/advance.
- The `/scale` page now has a Workflow 实例 section with start form, roles
  input, current-step/status table, and per-row advance action.
- Added `workflowInstances` query key; client typecheck, lint, tests, and
  standalone production build pass.

## Verification

```text
Client Jest: 6 suites / 21 tests passed
Standalone production build: passed
Type check + lint: passed
```
