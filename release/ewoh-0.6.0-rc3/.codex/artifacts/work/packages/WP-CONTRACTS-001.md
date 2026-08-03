# WP-CONTRACTS-001 Freeze C1-C6 v1

- package_id: WP-CONTRACTS-001 v1.0
- owner_agents: AG-01/02/03/04/05/06/30/51
- validator_agents: AG-40/41/42/43/44
- status: Refining

## Goal

Produce versioned shared contracts before domain implementation:

- C1 data contract: 48 managed tables, logical capability map, org_id rules.
- C2 API contract: paths, DTOs, errors, pagination, idempotency, optimistic lock.
- C3 state machines: task, approval, alert, plan, control.
- C4 security: DB roles, RLS, GUC, audit chain, credential encryption.
- C5 UI: routes, roles, states, Command Map grammar, design system.
- C6 DevOps: deploy, CI, monitoring, backup, rollback, SLO.

## Allowed Paths

- `.codex/artifacts/contracts/`
- `.codex/artifacts/inventory/docs-gap-report.md`

## Forbidden Paths

- `ewoh-spark-app/server/database/schema.ts`
- `ewoh-spark-app/client/src/`

## Acceptance

- Each contract file exists with version and owner.
- No contradictory table/field/route/state definitions across contracts.
- Gap report resolves conflicts using Final 3.0 as master.

## Evidence

- Contract files under `.codex/artifacts/contracts/`
- Gap report under `.codex/artifacts/inventory/docs-gap-report.md`
