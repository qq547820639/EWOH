# EWOH Demo Seed

File: `db/seed/001_demo_seed.sql`

Applies demo organization, spatial, personnel, device, telemetry, event, task,
schedule plan, model, and config rows. It is re-entrant (`ON CONFLICT DO
NOTHING`) and uses the `__EWOH_SCHEMA__` placeholder.

Run after DDL with the migration runner:

```bash
EWOH_DATABASE_URL='postgresql://...' \
EWOH_SCHEMA='workspace_aadknm4yzbyds' \
EWOH_ALLOW_DDL=1 \
node db/runner/run_migrations.js --plan seed

EWOH_DATABASE_URL='postgresql://...' \
EWOH_SCHEMA='workspace_aadknm4yzbyds' \
EWOH_ALLOW_DDL=1 \
node db/runner/run_migrations.js --seed
```
