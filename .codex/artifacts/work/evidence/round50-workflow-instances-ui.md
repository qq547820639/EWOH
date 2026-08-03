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
