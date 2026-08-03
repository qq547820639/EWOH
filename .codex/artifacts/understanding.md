# EWOH Current Understanding

Updated: 2026-08-03
Trace: EWOH-2026-08-03-principal-001

## Confirmed Current

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

## Source Map

- Goal: `.codex/artifacts/intent-anchor.md`
- Latest evidence: `.codex/artifacts/work/evidence/round3.md`
- Task status: `.codex/artifacts/task-board.md`
- Database generator: `scripts/generate-ddl-package.js`
- PostgreSQL gate: `scripts/standalone-postgres-check.sh`
- Auth/context implementation: `ewoh-spark-app/server/modules/auth/`,
  `ewoh-spark-app/server/modules/shared/`, and
  `ewoh-spark-app/server/database/request-database-context.ts`

## Next Entrypoint

Integrate the active independent reviews into a bounded implementation package.
