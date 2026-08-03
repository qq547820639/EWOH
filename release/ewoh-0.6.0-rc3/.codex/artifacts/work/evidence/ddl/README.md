# EWOH DDL Package Evidence

## Status

Live DDL verification is PENDING. The package was generated locally, but it
was not applied to the project dev database. The current role
`miaoda_cli_a347335089b96a88` has `USAGE` on `workspace_aadknm4yzbyds` but not
`CREATE`, so local live DDL cannot be executed by this role.

## Files

- `db/contracts/schema-manifest.yaml` - 48 managed tables plus additional
  hardened existing tables.
- `db/migrations/001_ewoh_managed_tables.sql` - re-entrant DDL using
  `__EWOH_SCHEMA__`.
- `db/migrations/001_ewoh_managed_tables.rollback.sql` - rollback that drops
  new objects and reverses grants/policies while retaining additive columns.
- `db/verify/001_verify.sql` - 12 assertion counters.
- `db/runner/run_migrations.js` - Node runner using the project `postgres`
  driver.
- `tmp/ddl/capability-map.csv` - logical capability to physical table mapping.

## Temporary PostgreSQL Runbook

Use a disposable PostgreSQL 17 database with a migration role that owns the
workspace schema:

```sql
CREATE ROLE anon_workspace_aadknm4yzbyds NOLOGIN;
CREATE ROLE authenticated_workspace_aadknm4yzbyds NOLOGIN;
CREATE ROLE user_authenticated_workspace_aadknm4yzbyds NOLOGIN;
CREATE ROLE service_role_workspace_aadknm4yzbyds NOLOGIN;
GRANT service_role_workspace_aadknm4yzbyds TO <migration_role>;
CREATE SCHEMA workspace_aadknm4yzbyds AUTHORIZATION <migration_role>;
```

Then run from the repository root:

```bash
EWOH_DATABASE_URL='postgresql://...' \
EWOH_SCHEMA='workspace_aadknm4yzbyds' \
EWOH_ALLOW_DDL=1 \
node db/runner/run_migrations.js --plan

EWOH_DATABASE_URL='postgresql://...' \
EWOH_SCHEMA='workspace_aadknm4yzbyds' \
EWOH_ALLOW_DDL=1 \
node db/runner/run_migrations.js --apply

EWOH_DATABASE_URL='postgresql://...' \
EWOH_SCHEMA='workspace_aadknm4yzbyds' \
node db/runner/run_migrations.js --verify

EWOH_DATABASE_URL='postgresql://...' \
EWOH_SCHEMA='workspace_aadknm4yzbyds' \
EWOH_ALLOW_DDL=1 \
node db/runner/run_migrations.js --rollback
```

`--plan` never connects to a database. `--apply`, `--rollback`, and
`--verify` were not executed against the dev database in this session.

## Notes

- The manifest resolves the authoritative plan's 38-name vs 36-CREATE
  inconsistency by mapping `ewoh_organization` and `ewoh_person` to existing
  tables and mapping `ewoh_device_person_binding` to `ewoh_device_binding`.
- All managed tables carry `org_id`; world snapshot/delta, system config, and
  audit log use a nullable `org_id` with special RLS rules.
- `audit_log` direct DML is revoked; writes go through the SECURITY DEFINER
  `ewoh_append_audit_log` function.
- The audit hash chain currently uses `md5` so the package has no hard
  `pgcrypto` dependency. This is integrity protection, not cryptographic
  immutability.
