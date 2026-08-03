# WP-ENV-001 Environment Probe

- package_id: WP-ENV-001 v1.0
- owner_agent: AG-10
- validator_agents: AG-40, AG-46
- status: Validation (evidence collected 2026-08-03)

## Goal

Establish executable environment facts before any DDL: toolchain, SQLite/PostgreSQL
state, roles, RLS posture, schema target, and build/test baseline.

## Allowed Paths

- `.codex/artifacts/inventory/environment.md`

## Forbidden Paths

- Any production or dev database DDL
- Source code changes

## Acceptance

- Toolchain versions recorded.
- PostgreSQL reachable read-only: version, current role, schema, table count,
  RLS policy count, role privileges.
- Baseline tests recorded with commands and results.
- Gaps against C4 security contract listed.

## Evidence

- `.codex/artifacts/inventory/environment.md`
- `state.json#verification_state`
