# EWOH Round 3 Execution Evidence

Date: 2026-08-03
Trace: EWOH-2026-08-03-principal-001

## Scope

- Harden standalone authentication, request database context, file isolation,
  health endpoints, runtime credentials, and deployment manifests.
- Close the PostgreSQL 17 migration, RLS, audit, rollback, and HTTP
  multi-organization acceptance gates.

## Database Evidence

- PostgreSQL server: 17.10 on the local test instance.
- Physical state after rebuild: 54 `ewoh_*` tables, comprising 53
  request-scoped business tables and `ewoh_user`.
- Generated standard and standalone DDL each set an
  `app.current_org_id`-derived default on all 53 business-table `org_id`
  columns.
- `scripts/standalone-postgres-check.sh` passed schema apply, verify, seed,
  runtime-role creation, idempotent reapply, RLS/security checks, destructive
  rollback to zero EWOH objects, rebuild, and repeated verification.
- Verify result: 48 managed tables, 48 with RLS, zero missing organization
  columns, zero nullable managed organization columns, zero missing request
  defaults, zero loose policies, and zero anonymous/authenticated business DML
  grants.
- Runtime role `ewoh_api` is non-superuser and `NOBYPASSRLS`; direct user-table
  access and direct audit mutation are denied.

## HTTP Evidence

- Rebuilt service started on `127.0.0.1:3101` with the runtime database URL.
- Health live/ready: 200/200; unauthenticated business API: 401.
- Login and valid refresh succeeded. Access-as-refresh and refresh-as-access
  were both rejected with 401.
- Organization A/B reads were mutually isolated; both cross-organization
  updates returned 404; global administrator read all acceptance rows.
- Organization A created a row without supplying `org_id`; owner-side query
  confirmed the stored organization ID exactly matched the request GUC.
- Temporary acceptance users and rows were deleted after verification.

## Code Verification

- Full Jest: 33 suites, 79 tests passed.
- `npm run lint`: passed, including server/client type checks, ESLint, and
  Stylelint.
- `npm run build:server`: passed in production mode.

## Environment Limits

- Docker, Kubernetes CLI, and `psql` are unavailable locally, so container
  image builds and cluster apply remain unexecuted here.
- Production database migration and deployment remain approval-gated.

## DB-Backed Audit Evidence

- Added `DatabaseAuditSink`, which calls `ewoh_append_audit_log` through the
  request-scoped transaction and uses the existing SHA-256 chain function.
- Added `GET /api/audit` with pagination and filters, plus an `/api/me` alias,
  reducing exact OpenAPI route drift to 3 unimplemented device paths.
- Organization and personnel create/update call `AuditService`, so writes are
  audited with the current request actor and organization.
- Live `:3101` HTTP acceptance: unauthenticated `/api/audit` returned 401;
  organization A saw only A's create/update rows, organization B saw only B's
  create row; every row had a 64-hex hash, 64-hex previous hash, and positive
  chain sequence; filtered query returned exactly one create row. Temporary
  users, organizations, and audit rows were deleted afterward.
