# WP-SHARED-001 Backend Shared Infrastructure

- package_id: WP-SHARED-001 v1.0
- owner_agent: AG-11
- validator_agents: AG-40, AG-42, AG-43
- status: Proposed

## Goal

Implement shared NestJS infrastructure:

- OrgContextInterceptor with transaction-level GUC (`app.user_id`,
  `app.current_org_id`, `app.current_org_ids`, `app.is_global_admin`).
- AuditService calling append_audit_log with service-layer deep redaction.
- OrgScopeService for child org scope and config inheritance.
- StateMachineGuard returning 409 STATE_NOT_ALLOWED.
- IdempotencyService and unified error/pagination helpers.

## Allowed Paths

- `ewoh-spark-app/server/modules/shared/**`
- `ewoh-spark-app/server/common/**`
- `ewoh-spark-app/test/unit/shared/**`

## Forbidden Paths

- `db/contracts/**`, `openapi/**`, `client/src/**`

## Acceptance

- Unit tests pass for GUC ordering, audit redaction, org scope, state guard,
  idempotency.
- Type check and lint pass for touched files.
- No source change outside allowed paths.
