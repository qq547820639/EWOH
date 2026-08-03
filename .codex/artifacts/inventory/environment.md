# EWOH Environment Probe

Status: confirmed_current (2026-08-03 local probe)

## Local Toolchain

| Tool | Version | Notes |
|------|---------|-------|
| Python | 3.9.6 | `python` alias missing; use `python3` |
| Node.js | 26.5.1 | |
| npm | 11.17.0 | |
| sqlite3 | 3.54.0 | |
| git | 2.54.0 | |
| docker | missing | local docker-compose cannot be exercised |
| psql | missing | DB probe uses Node `postgres` driver |

## Baseline Tests

| Check | Command | Result |
|-------|---------|--------|
| Python unit | `make test` (now uses `python3`) | 667 passed in ~23s |
| Repo contract tests | `PYTHONPATH=src python3 -m pytest tests/ -q` | 53 passed |
| Python lint | `make lint` (ruff) | 609 errors; legacy style debt |
| Makefile tests | `make test` / `make test-contract` | pass after Makefile uses `PYTHON ?= python3` |
| NestJS type check | `npm run type:check` | server + client pass |
| NestJS tests | `npm test` | 1 harness spec passes after jest ignores `dist/` |
| NestJS lint | `npm run lint` | eslint + typecheck + stylelint pass |
| NestJS build server | `npm run build:server` | pass |
| NestJS build client | `npm run build:client` | pass; 3.2MB main chunk warning |
| NestJS full build | `EWOH_SKIP_PLUGIN_INIT=1 npm run build` | pass (~71s; 278MB dist after prune) |

## PostgreSQL Probe (project-configured dev DB, read-only)

- Server: PostgreSQL 17.5; database `dataloom_db`; in-recovery false.
- Current role: `miaoda_cli_a347335089b96a88`, not superuser, `rolbypassrls=false`.
- Role probes: `anon`, `authenticated`, `service_role`, current role all exist;
  none is superuser; none has BYPASSRLS.
- Search path: `workspace_aadknm4yzbyds`.
- Schemas: `dataloom_auth`, `dataloom_meta`, `public`, `storage`,
  `workspace_aadknm4yzbyds`.
- Relations: 18 `ewoh_*` relations in the workspace schema.
- Existing ewoh tables: ai_suggestion, device, device_binding, device_config,
  environment, event, event_chain, model_registry, organization, personnel,
  production_task, schedule_audit, schedule_plan, scheduler_config,
  spatial_entity, telemetry, topology, world_state.
- RLS policies: 27 in workspace schema.
- Extensions: only `plpgsql`.

## Security Gaps Found

1. Existing RLS policies are permissive: `查看全部数据` has `qual=true` for
   anon/authenticated workspace roles; `修改全部数据` has `qual=true` for
   authenticated workspace role.
2. Grants show anon/authenticated workspace roles hold ALL DML privileges on
   ewoh tables (INSERT/UPDATE/DELETE/TRUNCATE), violating the authoritative
   contract that final users cannot access the DB directly and authenticated
   has no business-table DML.
3. Most existing tables lack `org_id` (only `ewoh_personnel` has an org field),
   so the 12-table ALTER + RLS migration is still required.
4. No `ewoh_audit_log`, `world_delta_log`, control/task/resource tables yet;
   only 18 of 48 managed tables exist.
5. Roles are workspace-suffixed (`authenticated_workspace_aadknm4yzbyds`), so
   DDL must target the workspace schema and workspace roles, not plain
   `authenticated`/`service_role`.

## Next Probe Items

- Verify `gen_random_uuid()` and advisory lock functions.
- Verify audit trigger/function ownership capability.
- Verify user_profile/platform table shape used by the Miaoda runtime.
- Decide whether DDL may run against this dev DB or only a temporary DB.

## Harness Fixes Applied

- `Makefile`: `PYTHON ?= python3`; all Python invocations use `$(PYTHON)`.
- `ewoh-spark-app/package.json`: jest ignores `dist/` and node_modules.
- `ewoh-spark-app/test/unit/harness.spec.ts`: first Jest spec.
- `ewoh-spark-app/scripts/build.sh`: supports `EWOH_SKIP_PLUGIN_INIT=1`.
- `.github/workflows/test.yml`: runs Python unittest, repo contract tests,
  ruff, Node type check, Jest, and production build.
