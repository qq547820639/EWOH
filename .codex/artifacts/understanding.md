# EWOH Current Understanding

Updated: 2026-08-03
Trace: EWOH-2026-08-03-principal-001

## Confirmed Current

- Final 4.0 is the master execution baseline: it names the current public
  repository `0.6.0-rc2` as the real implementation baseline and puts MES P0,
  real-device truth, and ten scenario packages on the critical path.
- MES P0 is mapped to existing physical tables
  (`ewoh_schedule_task`, `ewoh_schedule_task_step`, `ewoh_resource_binding`,
  `ewoh_event`) so the frozen 48-table packaging remains unchanged.

- Standalone NestJS uses `ewoh_api`, a non-owner PostgreSQL role without RLS
  bypass, for runtime queries.
- Protected HTTP requests execute inside one database transaction with
  `app.user_id`, `app.current_org_id`, `app.current_org_ids`, and
  `app.is_global_admin` set transaction-locally.
- The generated DDL covers 53 request-scoped business tables; every `org_id`
  has a request organization default and RLS remains the write authority.
- PostgreSQL 17.10 apply/verify/security/rollback/rebuild and real A/B/global
  HTTP authorization acceptance passed on the local test environment.
- Full NestJS Jest, lint/type checks, and production server build pass.
- Organization/personnel writes append redacted entries through
  `ewoh_append_audit_log`; `GET /api/audit` returns request-scoped rows with
  chain fields and live multi-org HTTP acceptance passed.

## Memory Derived, Under Review

- The task board lists broad W2/W3 domain coverage, but persistence and true
  end-to-end completeness vary by module.
- The eight scenario tests exist, but their degree of HTTP/database realism is
  not yet independently classified.
- Frontend has 11 center routes, with a mix of production workflows and
  contract placeholders.

## Stale Or Unverified

- Docker image build and Kubernetes apply in the current environment.
- Real device/gateway integration, production observability, production
  migration, gray rollout, training, and business signoff.
- MES P0 production execution, OEE/andon, quality/traceability, mobile
  workbench, and ERP connector are still the next implementation packages.

## Source Map

- Goal: `.codex/artifacts/intent-anchor.md`
- Latest evidence: `.codex/artifacts/work/evidence/round9-observability-deploy-artifacts.md`
- Task status: `.codex/artifacts/task-board.md`
- Database generator: `scripts/generate-ddl-package.js`
- PostgreSQL gate: `scripts/standalone-postgres-check.sh`
- Auth/context implementation: `ewoh-spark-app/server/modules/auth/`,
  `ewoh-spark-app/server/modules/shared/`, and
  `ewoh-spark-app/server/database/request-database-context.ts`

## Next Entrypoint

Adopt Final 4.0 baseline and implement WP-MES-01 production execution closed
loop using existing schedule/resource/event tables, then extend to OEE/andon
and quality traceability.
