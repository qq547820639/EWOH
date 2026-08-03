# Security Contract (C4 v1.0)

Owner: AG-06
Status: C4 v1.0 frozen/validated (2026-08-03)
Source: `ewoh-spark-app/server/modules/{auth,shared,audit,system,dashboard}/**`,
`ewoh-spark-app/server/database/**`, `ewoh-spark-app/server/standalone-main.ts`,
`db/migrations/standalone_*.sql`, `scripts/verify-standalone-security.js`,
`security/access-matrix.yaml`, `.codex/artifacts/work/reviews/security-review-2026-08-03.md`,
`.codex/artifacts/work/reviews/persistence-tenancy-2026-08-03.md`,
`.codex/artifacts/work/evidence/round4.md`

## Authentication and Authorization

- Public surface: `/health/*`, `/api/auth/login`, `/api/auth/refresh`,
  `/api/auth/logout`, SPA fallback, and `/api/ingest/*` (machine-to-machine,
  guarded by `IngestGuard`: `X-Ingest-Key` equals `INGEST_API_KEY` when
  configured; the guard falls open only when the env key is unset).
- `AccessTokenGuard` is global: Bearer HS256 access JWT, payload type
  `access`, `JWT_SECRET` must be at least 32 chars.
- `RolesGuard` is global and default-denies handlers without `@Roles` metadata
  or a policy fallback. `route-role.policy.ts` supplies conservative
  controller-level fallbacks for task/alert/model/scheduler/control/approval/
  resource/world-cursor/simulator. `viewer`/`worker` are valid authenticated
  roles but are not granted any business center except `/api/me`.
- Audit read is restricted to `safety_admin`/`global_admin`; non-admin roles
  receive `clientIp: null`. System config read/write is `global_admin` only
  and `updatedBy` is always derived from `userContext`, never the body.
- E2E asserts unauthenticated business calls 401 and viewer calls to
  `/api/system/config`, `/api/audit`, and control writes return 403.

Known divergence: `DeviceContractController` (`/api/devices`) has no role
metadata and no fallback, so RolesGuard currently denies all authenticated
users by default. The shipped UI does not call `/api/devices` (it uses
`/api/dashboard/devices`), so this is fail-closed but leaves the documented
device contract routes unusable until roles are declared. UI also shows the
system center to `safety_admin` while the API is `global_admin` only; the
matrix below follows the enforced API.

## Refresh Tokens and Sessions

- Refresh JWT carries `jti`; the allowlist entry is
  `auth:refresh:{jti}` in Redis.
- Every refresh rotates: presented jti is deleted before issuing a new token;
  reuse of a rotated token returns 401.
- `POST /api/auth/logout` revokes the presented refresh jti.
- Access-as-refresh and refresh-as-access are both rejected by payload type
  checks on every path.
- Defaults: access 8h (`JWT_EXPIRES_IN`), refresh 30d
  (`REFRESH_TOKEN_EXPIRES_IN`).
- Pending: no per-user token version/session table, so password change or user
  disable does not revoke outstanding refresh tokens; login timing still
  differs for unknown usernames and there is no per-account lockout.

## Rate Limiting

- `RateLimitGuard` is global (health exempt). Authenticated requests bucket by
  `userContext.userId`; anonymous requests bucket by Express-resolved
  `request.ip`.
- `standalone-main.ts` sets `trust proxy` from `TRUST_PROXY` (default 1 hop;
  literal `true` is rejected; numeric hop count or explicit CIDR list allowed),
  so behind an ingress the anonymous bucket uses the forwarded client address.
- Default: 300 req/min (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_SEC`), 429
  `RATE_LIMITED`.
- Ingest path additionally limits 100 req/min per IP in-process.
- Pending: Redis failure falls back to per-replica in-memory counters; a
  multi-replica rate-limit test has not been executed.

## Database Access Model

- Runtime role `ewoh_api`: LOGIN, INHERIT, NOSUPERUSER, NOCREATEDB,
  NOCREATEROLE, NOREPLICATION, NOBYPASSRLS, member of `service_role`,
  `search_path=public,pg_temp`.
- `anon`/`authenticated` have no business-table DML; DML is granted only to
  `service_role`.
- `ewoh_user` direct read/update is denied to the API role; login uses
  `ewoh_find_active_user` (SECURITY DEFINER, pinned `search_path`).
- `ewoh_audit_log` has no user UPDATE/DELETE grants; writes go through
  `ewoh_append_audit_log` (SECURITY DEFINER, org-visibility checked).
- `scripts/verify-standalone-security.js` re-verifies role attributes, direct
  user read denial, org A/B RLS read/write/insert, global admin read, audit
  chain recomputation, cross-org audit append denial, and tamper denial.

## Org Context and RLS

- Per authenticated request, `OrgContextInterceptor` opens one transaction and
  sets, in order: `app.user_id`, `app.current_org_id`,
  `app.current_org_ids`, `app.is_global_admin` via `set_config(..., true)`.
- The pooled fallback path was removed; missing `RequestDatabaseContext` is a
  500, never a silent GUC skip.
- Legacy bootstrap now fails fast unless `EWOH_LEGACY_ENABLED=1`; standalone is
  the default deployment path.
- Simulator background ticks run inside the same request-scoped transaction
  mechanism with `EWOH_SIMULATOR_ORG_ID` and expose `simulationErrorCount`.
- RLS: 48 managed tables with org visibility; `world_snapshot` /
  `world_delta_log` allow NULL org only to global admin; `system_config` public
  rows remain readable without org scope; audit select is org-scoped through
  `service_role`.
- Pending: tenant boundary is RLS-only; Drizzle schema and services carry no
  app-layer `org_id` filters, `accessibleOrgIds` is always the primary org
  (`[orgId]`), and `OrgScopeService` hierarchy resolution is unused.

## Audit Integrity

- SHA-256 per-org chain with `audit_seq`, `prev_hash`, `hash`,
  `pg_advisory_xact_lock` serialization, and UTC timestamps.
- Audit payload covers actor, org, action, entity, before/after, reason, IP,
  requestId, risk flag.
- Audit reads: `safety_admin`/`global_admin`; client IP masked for everyone
  else.
- Redaction happens before persist for sensitive keys, credential-like
  strings, and auth config.
- Writes currently audited: organization/personnel, task, alert, model,
  scheduler confirm, approval step/action/bypass/cancel.
- Pending: control requests, resource issue/release, world snapshot/delta,
  device lifecycle, file operations, and event handling are not yet written to
  the audit chain; daily full-chain verification and anomaly freeze are
  contract terms but not yet automated.

## Sensitive Data

- Personnel detail without the sensitive route returns coarse
  `riskLevel` and omits `currentLoad`/`healthStatus`; full detail is
  `safety_admin`/`global_admin` only (`/api/personnel/:id/sensitive`).
- System config values are masked recursively for password/secret/token/
  credential/access-key/auth-config/private-key keys on every read.
- Pending: AES-256-GCM data-source credential vault, key rotation, precise
  location retention windows, and de-identified 30-90 day aggregates are not
  implemented in the standalone NestJS app.

## Safety Boundary

- No software e-stop, realtime joint control, or assisted closed-loop control
  endpoint is implemented; `security.yml` blocks forbidden safety symbols in
  platform code.
- Web UI never replaces physical e-stop.
- Schedule freeze, instruction freeze, and real-device e-stop marker remain
  safety requirements, not yet delivered as audited production controls.

## Production Gates

DDL, deploy, credential changes, permission expansion, and irreversible
operations require explicit user approval. Production deployment has not been
executed.
