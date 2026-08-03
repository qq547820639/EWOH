# EWOH Acceptance Evidence

Status: validated v1.2 (2026-08-03 hardening wave)
Owner: AG-00/AG-41

## Automated Evidence

- Python unittest: 667 passed.
- Python repo contract tests: 53 passed.
- NestJS Jest: 137 passed across 39 suites (includes SP-01..SP-08 scenario
  suite).
- HTTP + PostgreSQL E2E: 11 passed (auth, RBAC, refresh rotation/logout, org
  isolation, control/resource/world persistence, approval persistence, system
  config org scoping).
- NestJS type check, lint, and Standalone production build: passed.
- One-click `scripts/standalone-check.sh`: passed with E2E, OpenAPI strict
  audit, DDL plans, and standalone DDL hygiene.
- OpenAPI contract: 106 controller operations documented, 0 undocumented,
  0 unimplemented; `openapi/route-manifest.json` generated.
- Browser regression: Playwright verified login, command center, command map,
  devices, and alerts pages with real data on `http://127.0.0.1:3200`.
- Performance smoke: 1000 requests / 50 concurrency on `/health/live`,
  6718 qps, p95 14.63ms, 0 failures.
- Approval persistence: instances/steps/actions mapped to
  `ewoh_event`/`ewoh_event_chain`/`ewoh_audit_log` and verified in E2E.

## PostgreSQL 17.10 Standalone Evidence

- Applied standalone schema, seed, user auth, and non-owner runtime role to the
  local PostgreSQL 17.10 test instance.
- Reapplied all idempotent migrations and verified 48 managed tables, 48 RLS
  tables, zero missing `org_id` columns, zero nullable managed `org_id`
  columns, zero missing request organization defaults, zero loose policies,
  and zero `authenticated` or `anon` business-table grants.
- Verified `ewoh_api` is a login role without superuser, database creation,
  role creation, replication, or RLS bypass privileges. Direct `ewoh_user`
  reads are denied; controlled `SECURITY DEFINER` lookup succeeds.
- Verified organization A positive read/update, organization B negative
  read/update/insert, global administrator cross-organization read, audit
  append controls, direct audit tamper denial, and two-entry SHA-256 chain
  recomputation.
- Performed destructive standalone rollback and observed zero remaining EWOH
  relations/functions, then rebuilt and repeated all verification successfully.

## HTTP Authorization Evidence

- Started the rebuilt standalone API on `127.0.0.1:3101` using the non-owner
  `ewoh_api` database role.
- `/health/live` and `/health/ready` returned 200 without authentication;
  unauthenticated `/api/organization` returned 401.
- Three temporary A/B/global users logged in successfully; access tokens were
  rejected by the refresh endpoint and refresh tokens were rejected by protected
  APIs. A valid refresh token issued a usable access token.
- Organization A and B could read and update only their own rows. Both cross-org
  updates returned 404, while the global administrator could read A, B, and the
  A-created child organization.
- `POST /api/organization` omitted `org_id`; an owner-side database query proved
  PostgreSQL stored the request's `app.current_org_id` value. Temporary users and
  organizations were removed after verification.

## HTTP Audit Evidence

- Added a database audit sink that calls the `ewoh_append_audit_log`
  SECURITY DEFINER function inside the request transaction.
- Added `GET /api/audit` with pagination, entity/action/actor filters, and the
  SHA-256 chain fields; unauthenticated access returned 401.
- Organization create/update and personnel create/update now append redacted
  audit entries through `AuditService`.
- Live verification: two temporary organizations created data through HTTP;
  `/api/audit` for organization A returned only A's `organization.create` and
  `organization.update` rows, organization B returned only B's create row, all
  rows carried 64-character `hash`/`prev_hash` values, and filtered queries
  returned exactly the matching row. Temporary data was removed afterward.

## GitHub Actions Evidence (2026-08-03)

- Branch `codex/rc1-ci-full`, commit `7474121`.
- `standalone`: success, including Docker image build, PostgreSQL 17
  migration/RLS/audit/rollback, E2E 11/11, OpenAPI 106/106.
- `test`: success (Python unittest, pytest, ruff).
- `security`: success (bandit `-ll`).

## Scenario Coverage

- SP-01..SP-08 retain unit smoke coverage under `test/scenarios`.
- Real HTTP + PostgreSQL E2E covers health, 401/403 RBAC, refresh token
  rotation/revocation, org A/B isolation, world cursor expiry, control request
  persistence, approval instance/step/audit persistence, and org-scoped system
  config.
- Device contract routes `/api/devices*` are enforced for
  `global_admin`/`dispatcher`/`device_ops` and verified in E2E.

## Pending

- Real device/gateway integration evidence.
- Local container/Kubernetes build/apply evidence (Docker CLI unavailable in
  the current environment; CI workflow includes Docker image build steps).
- Production deployment, monitoring, training, and user signoff.
