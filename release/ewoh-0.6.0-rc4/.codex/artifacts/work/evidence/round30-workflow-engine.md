# Round 30 Evidence - Workflow Engine Skeleton

Date: 2026-08-03
Scope: Final 5.0 Y1-06 workflow skeleton.

## Implemented

- Added `contracts/workflow/workflow-schema.json` (`ewoh:///workflow/v1`)
  requiring `workflowId`, `version`, `start`, and non-empty `steps` with
  role-gated transitions.
- Added canonical `mes-execution.yaml` with 8 MES P0 steps.
- `POST /api/workflows/advance` validates a workflow and returns the current
  action's role allowance plus role-filtered next steps;
  `GET /api/workflows/examples` serves the canonical workflow.
- Added `scripts/audit-workflow-contracts.js` (16 checks), `npm run contract:workflow`,
  and unit/contract tests.
- E2E verifies worker cannot advance to quality-only inspection while a quality
  role can.

## Verification

```text
Workflow contract audit: schema ewoh:///workflow/v1 | mes-execution 1.0.0 | 8 steps | 16 checks passed
OpenAPI strict audit: 168/168
HTTP + PostgreSQL E2E: 22/22 passed including role-aware workflow advance
```
