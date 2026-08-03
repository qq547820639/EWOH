# EWOH Environment Probe

Status: confirmed_current (2026-08-04 local probe)

## Local Toolchain

| Tool | Version | Notes |
|------|---------|-------|
| Python | 3.9.6 | `python` alias missing; use `python3` |
| Node.js | 26.5.1 | |
| npm | 11.17.0 | |
| sqlite3 | 3.54.0 | |
| git | 2.54.0 | branch `main`, head `33802e3` |
| docker | missing | local docker-compose cannot be exercised |
| psql | missing | DB probes use Node `postgres` driver |

## PostgreSQL Probe

- Server: PostgreSQL 17.10 on 127.0.0.1:55432 (embedded local test instance).
- Roles verified: `postgres` (owner), `ewoh_api` (runtime,
  `LOGIN NOBYPASSRLS`).
- Current public schema contains 59 `ewoh_*` relations after the standalone
  DDL/RLS/audit/rollback/rebuild gate.
- Direct `ewoh_user` reads by `ewoh_api` are denied; SECURITY DEFINER lookup
  resolves active users.
- Audit writes are restricted to `ewoh_append_audit_log`; hash chain and
  cross-org denial verified by `verify-standalone-security.js`.

## Verified Capability Limits

- No Docker, Kubernetes, Helm CLI, or `psql` on this machine; container and
  cluster execution remains external-state evidence.
- Python runtime is 3.9.6; the app uses workspace/venv Python when needed.
- Local standalone server runs from `ewoh-spark-app/dist/server/main.js` with
  `EWOH_DEPLOY_TARGET=standalone`.

## Gate Evidence (2026-08-04)

- `scripts/standalone-postgres-check.sh`: PASSED (apply, verify, idempotent
  reapply, RLS, audit chain, destructive rollback to 0 objects, rebuild).
- `scripts/standalone-check.sh` with E2E: PASSED.
- Jest 72 suites / 320 tests; E2E 29/29; OpenAPI 227/227.
