# EWOH Training Plan

Status: draft v1.0
Owner: AG-52

## Audiences

- Global admins: org/space management, system config, model release.
- Dispatchers: task orchestration, resource preorder, AI suggestion/plan,
  control request.
- Workshop leads: task approval, alert handling, exception recovery.
- Safety admins: sensitive health access, alert close/reopen, approval bypass.
- Device ops: device search, config, binding, model assets.
- Operators: personal task view and risk feedback.

## Materials

- Deployment runbook: `docs/delivery/deployment-runbook.md`.
- Release checklist: `docs/delivery/release-checklist.md`.
- Acceptance evidence: `docs/delivery/acceptance-evidence.md`.
- Existing product/architecture docs under `docs/` and `delivery/`.

## Drills

- DDL apply/verify/rollback in a temporary PostgreSQL.
- Alert acknowledge/process/close/reopen drill.
- Task dispatch/execute/exception drill.
- AI suggestion/plan manual trigger drill.
- Control request retry/revoke drill.
- Cross-org access denial drill.
- Audit chain continuity check drill.
