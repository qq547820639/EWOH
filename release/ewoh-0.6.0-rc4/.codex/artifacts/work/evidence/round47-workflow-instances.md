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
