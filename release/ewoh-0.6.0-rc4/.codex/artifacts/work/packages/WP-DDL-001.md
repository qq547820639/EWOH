# WP-DDL-001 DDL, Migration, and Temp-DB Verification

- package_id: WP-DDL-001 v1.0
- owner_agent: AG-10
- validator_agents: AG-40, AG-43
- status: Proposed

## Goal

Generate the 36 new table CREATE scripts and 12 existing table ALTER scripts
for the workspace schema, plus default-org backfill, RLS policies, grants,
audit function, identity columns, rollback scripts, and capability mapping.

## Inputs

- C1 data contract: `.codex/artifacts/contracts/data-contract.md`
- C4 security contract: `.codex/artifacts/contracts/security-contract.md`
- Environment probe: `.codex/artifacts/inventory/environment.md`
- Existing DB: workspace `workspace_aadknm4yzbyds`, 18 ewoh tables

## Allowed Paths

- `db/`
- `scripts/`
- `tmp/ddl/`
- `.codex/artifacts/work/evidence/ddl/`

## Forbidden Paths

- `ewoh-spark-app/server/database/schema.ts` (codegen owns it)
- Production database execution without explicit user approval

## Acceptance

- DDL compiles in a temporary PostgreSQL database.
- Every one of the 48 managed tables is present after migration.
- RLS denies cross-org reads and direct authenticated DML.
- Rollback scripts restore the pre-migration schema.
- Capability mapping covers every frozen logical capability.

## Rollback

- Reverse migration scripts are part of the package.
- Dev DB execution requires user approval.
