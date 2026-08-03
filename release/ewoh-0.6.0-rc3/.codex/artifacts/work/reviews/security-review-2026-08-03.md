# EWOH Standalone NestJS — Independent Security Review (2026-08-03)

Reviewer: independent verification agent (read-only; no source files modified).
Scope: `ewoh-spark-app/server/modules/{auth,audit,files,system,shared}`, `server/database/request-database-context.ts`, `server/common/**`, `scripts/verify-standalone-security.js`, `db/migrations/standalone_*`, `security/access-matrix.yaml`, `deploy/cloud/**`. Supporting files read: `standalone-main.ts`, `standalone-app.module.ts`, `standalone.provider.ts`, `server/database/schema.ts`, `db/runner/run_migrations.js`, `db/seed/standalone_*`.
Validation: ran `npx jest --runInBand test/unit/auth test/unit/shared test/unit/audit test/unit/system test/unit/files` — 20 suites / 47 tests, all passed. Unit tests mock the DB and do not exercise the findings below (controller role enforcement, ON CONFLICT SQL, rate-limit scoping).

```yaml
review_status: fail
severity_counts:
  critical: 0
  major: 4
  minor: 7
  suggestion: 4
anchor_alignment:
  status: aligned
  notes: "All requested paths inspected; verify-standalone-security.js lives at repo-root scripts/, not ewoh-spark-app/scripts."
plan_challenge:
  status: none
  notes: "No plan to challenge; the review matched the requested scope."
repeated_error_patterns:
  - pattern: "missing role/authorization enforcement on controllers (RolesGuard only acts when @Roles metadata exists)"
    count: 4
    evidence:
      - "server/modules/control/control.controller.ts:9-24 (no @Roles, no userContext use)"
      - "server/modules/audit/audit.controller.ts:15-30 (no @Roles)"
      - "server/modules/system/system.controller.ts:9-24 (no @Roles)"
      - "server/modules/shared/roles.guard.ts:16-22 (returns true when no metadata)"
    recommended_loop: L2_strategy
  - pattern: "drizzle schema vs SQL migration drift (unique index declared but never created)"
    count: 1
    evidence:
      - "server/database/schema.ts:311 uniqueIndex vs db/migrations/standalone_001_schema.sql:258-267,1333"
    recommended_loop: none
defects:
  - severity: major
    file_or_symbol: "server/modules/shared/roles.guard.ts:16-22"
    issue: "Role-based authorization is effectively unenforced: @Roles is used on exactly 1 of 24 controllers (organization.controller.ts:56). Control, audit, system, files, and all other modules rely only on authentication + RLS org scoping."
    impact: "Any authenticated user (default role is 'viewer', standalone_002_users.sql:20) can call POST /api/control/requests and POST /api/control/requests/:id/commands (real-time joint control, forbidden for any_authenticated in access-matrix.yaml), read the org audit trail, and read/write org scheduler config. Directly contradicts security/access-matrix.yaml."
    recommendation: "Add @Roles(...) per access-matrix.yaml on every sensitive controller; make RolesGuard default-deny for handlers without role metadata on non-public routes; add unit tests asserting 403 for viewer roles."
    evidence: "rg shows @Roles in only server/modules/organization/organization.controller.ts:56; standalone-app.module.ts:69-79 registers RolesGuard globally."
  - severity: major
    file_or_symbol: "server/modules/auth/auth.service.ts:47-65"
    issue: "Refresh tokens are never rotated, revocable, or bound to a session/token version; there is no logout endpoint (auth.controller.ts)."
    impact: "A stolen refresh token can be replayed for the full 30-day window (REFRESH_TOKEN_EXPIRES_IN), and password resets/seeding never invalidate outstanding tokens (ewoh_user has no token_version column). Persistent account takeover with no recovery path."
    recommendation: "Rotate refresh tokens on every refresh (new jti, blacklist/allowlist in Redis), add a logout/revoke endpoint, and store a per-user token version checked at refresh."
    evidence: "refresh() verifies any valid 'refresh' JWT and re-issues; issue() at auth.service.ts:77-96; no jti/session store; token-type confusion itself is correctly prevented (type checks at :57-59 and :66-75)."
  - severity: major
    file_or_symbol: "server/modules/shared/rate-limit.guard.ts:21-28"
    issue: "Rate limiting keys on request.ip, but standalone-main.ts never sets Express 'trust proxy'; deploy/cloud/README.md:22-24 documents scaling behind a load balancer and k8s/ingress.yaml is provided."
    impact: "Behind an LB/ingress every client shares the LB IP: one global 300 req/min bucket for the entire deployment (any user or bot can DoS all users), and per-user protection is absent. RedisService's in-memory fallback (redis.service.ts:29-47) makes counters per-replica when Redis errors, allowing limit bypass at scale."
    recommendation: "Configure 'trust proxy' to the known proxy CIDRs and key buckets on the client address from X-Forwarded-For; add per-account login throttling; verify with a multi-replica test."
    evidence: "rate-limit.guard.ts uses request.ip ?? 'unknown'; standalone-main.ts has no trust-proxy call; config default RATE_LIMIT_MAX=300."
  - severity: major
    file_or_symbol: "server/modules/system/system.service.ts:66-78"
    issue: "PUT /api/system/config runs onConflictDoUpdate({ target: configKey }) but no SQL migration creates a unique index on ewoh_scheduler_config.config_key (schema.ts:311 declares one; standalone_001_schema.sql only creates idx_ewoh_scheduler_config_org at :1333). PostgreSQL raises 42P10 ('no unique or exclusion constraint matching the ON CONFLICT specification')."
    impact: "Config writes always 500 (broken management path). If the declared global-unique index is later created, it contradicts the org-scoped RLS design: a viewer in org A can squat a config key so org B can never write it (conflict-update of org A's row is blocked by RLS), a cross-org availability attack."
    recommendation: "Create a per-org unique index (org_id, config_key) and target [orgId, configKey] in the upsert; align schema.ts with the migration; add an integration test against PostgreSQL."
    evidence: "standalone_001_schema.sql:258-267 (no unique constraint), :1333; server/database/schema.ts:311 uniqueIndex; unit test mocks the DB and does not catch this."
  - severity: minor
    file_or_symbol: "server/modules/audit/audit.controller.ts:15-30"
    issue: "Audit list endpoint has no @Roles; any authenticated org member can read the org audit trail including before_json/after_json, actor ids, and client_ip (audit.service.ts:74-97)."
    impact: "In-org data exposure (states, IPs, actor attribution) to roles the access matrix reserves to safety_admin/global_admin; audit read access is org-scoped by RLS (standalone_001_schema.sql:1492-1494), so no cross-org leak."
    recommendation: "Add @Roles('safety_admin','global_admin') to AuditController and mask client_ip for non-admin roles."
    evidence: "No @Roles in audit.controller.ts; matrix roles.safety_admin includes audit center."
  - severity: minor
    file_or_symbol: "server/modules/system/system.controller.ts:20-24"
    issue: "System config GET/PUT have no role check, and PUT accepts body.updatedBy from the client, falling back to userContext only when absent."
    impact: "Any authenticated user can read/write the org's scheduler config (masked on read but overwriteable with attacker values), and can forge audit attribution via updatedBy."
    recommendation: "Always derive updatedBy from userContext; require @Roles('global_admin') per matrix (system center)."
    evidence: "system.controller.ts:20-24; system.service.ts:51-79."
  - severity: minor
    file_or_symbol: "deploy/cloud/k8s/configmap.yaml:12-31"
    issue: "ConfigMap sets REQUIRE_OBJECT_STORAGE=true with empty OBJECT_STORAGE_ENDPOINT/BUCKET; storage-driver.factory.ts:10-13 throws at FilesModule init (file.module.ts:10-13)."
    impact: "The shipped k8s manifests crash-loop the API at startup. Compose variant is consistent (flag unset), so only k8s is broken."
    recommendation: "Set REQUIRE_OBJECT_STORAGE=false or provide endpoint/bucket in the ConfigMap/Secret before rollout."
    evidence: "deploy/cloud/k8s/configmap.yaml vs storage-driver.factory.ts:10-13."
  - severity: minor
    file_or_symbol: "deploy/cloud/k8s/ingress.yaml:1-20"
    issue: "Ingress has no tls: block, and standalone-main.ts applies no security headers (no helmet/CSP/X-Content-Type-Options/HSTS)."
    impact: "Bearer tokens and credentials traverse plaintext HTTP unless TLS is terminated elsewhere; no clickjacking/sniffing protections on the SPA."
    recommendation: "Add TLS + annotations to the ingress; add helmet and HSTS in bootstrapStandalone."
    evidence: "ingress.yaml has no tls stanza; standalone-main.ts uses only enableCors/useBodyParser/useStaticAssets."
  - severity: minor
    file_or_symbol: "db/migrations/standalone_001_schema.sql:191"
    issue: "ewoh_personnel.org_id is varchar(255) while the RLS function ewoh_org_visible takes uuid (standalone_001_schema.sql:25-40); non-UUID or NULL org_id values fail or hide rows during RLS evaluation (22P02 cast error on every query of the table)."
    impact: "Legacy or malformed personnel rows can 500 all personnel queries; NULL-org personnel rows are invisible to non-admins."
    recommendation: "Normalize org_id to uuid with a data backfill, or make the policy cast-safe (org_id::text comparison); add a verify probe for this table."
    evidence: "standalone_001_schema.sql:191 varchar(255) vs :25-40 uuid parameter."
  - severity: minor
    file_or_symbol: "server/modules/auth/auth.service.ts:34-44"
    issue: "Login returns immediately when the user does not exist but runs bcrypt.compare (~50-150ms with bcryptjs) when the user exists, enabling timing-based username enumeration; only an IP-based 300 req/min limit exists, no per-account lockout."
    impact: "Username enumeration and distributed password brute force against weak passwords."
    recommendation: "Always run a dummy bcrypt compare for unknown users; add per-account failed-login backoff/lockout; audit failures."
    evidence: "auth.service.ts:34-44; rate-limit.guard.ts:21-28 (IP-only)."
  - severity: minor
    file_or_symbol: "server/database/standalone.provider.ts:13-20"
    issue: "postgres.js client is created without any ssl option; managed PostgreSQL connections may fall back to plaintext if DATABASE_URL lacks sslmode."
    impact: "DB credentials and all query data (including password hashes served by ewoh_find_active_user) could transit unencrypted."
    recommendation: "Require SSL (ssl: {rejectUnauthorized:true}) or document sslmode=require in DATABASE_URL; enforce in compose/k8s examples."
    evidence: "standalone.provider.ts:13-20; db/migrations/standalone_002_users.sql:31-45 (hash returned to API role)."
  - severity: suggestion
    file_or_symbol: "scripts/verify-standalone-security.js:20-52"
    issue: "The verify script sets GUCs manually instead of exercising the OrgContextInterceptor/RequestDatabaseContext transaction path, and covers no API-level controls: @Roles enforcement, refresh-token handling, rate-limit scoping, CORS, file access. It also never asserts RLS is enabled on every granted table."
    impact: "DB-level RLS is well verified, but the top API-level regressions (this report's majors) would pass verification."
    recommendation: "Add API-level negative tests (viewer calling control/audit/system endpoints) and a pg_class relrowsecurity registry check; run the security probe through the real request pipeline."
    evidence: "verify-standalone-security.js sets set_config directly at :44-52 and asserts DB role/RLS/audit chain only."
  - severity: suggestion
    file_or_symbol: "deploy/cloud/docker-compose.standalone.yml:17-25"
    issue: "Redis runs without requirepass; acceptable on the isolated compose network but the rate-limit and idempotency state then trust the network."
    impact: "If the compose network is exposed or bridged, anyone can reset rate-limit counters or inject idempotency keys."
    recommendation: "Add a required REDIS_PASSWORD and run redis-server with --requirepass; note TLS for managed Redis."
    evidence: "docker-compose.standalone.yml:17-25; redis.service.ts consumes REDIS_URL."
  - severity: suggestion
    file_or_symbol: "server/modules/shared/org-context.interceptor.ts:81-89"
    issue: "The non-transactional fallback (applyGucSettings) applies set_config(..., true) as standalone statements on the pool; each GUC is discarded at statement end, so handler queries run without org context (RLS fail-closed: empty results/failed inserts)."
    impact: "Not exploitable in standalone (RequestDatabaseContext is always provided), but the @Optional() injection makes the broken path silently reachable if DI wiring changes."
    recommendation: "Make RequestDatabaseContext a required dependency and assert the transactional path in tests."
    evidence: "org-context.interceptor.ts:66-89; request-database-context.ts:39-47."
  - severity: suggestion
    file_or_symbol: "ewoh-spark-app/.env"
    issue: "ewoh-spark-app/.env is tracked in git (committed at 3eb2aa2); current content is only LOG_DIR/LOG_REQUEST_BODY/LOG_RESPONSE_BODY (no secrets found), and those LOG_* keys are referenced by no code."
    impact: "Low today, but a tracked .env is a future secret-leak vector; dead body-logging flags invite accidental credential logging."
    recommendation: "git rm --cached .env and add to .gitignore; wire body logging (if intended) through the redacting AuditService instead."
    evidence: "git ls-files shows .env; rg finds no LOG_REQUEST_BODY/LOG_RESPONSE_BODY consumers."
```

## Verified-sound controls (inspected, not findings)

- JWT secret enforcement: `auth.service.ts:25-30` throws unless `JWT_SECRET` >= 32 chars; HS256 algorithm is pinned on both verify paths (`auth.service.ts:52,71`); access/refresh type confusion is prevented by payload `type` checks in both directions.
- Password handling: bcryptjs compare (`auth.service.ts:38-43`); admin seed uses bcrypt cost 12 and rejects passwords < 12 chars (`db/runner/run_migrations.js:93-104`).
- Fail-closed DB auth: `ewoh_api` is LOGIN, NOSUPERUSER, NOBYPASSRLS, no CREATEDB/CREATEROLE (`standalone_003_runtime_role.sql:3-15`); direct DML on `ewoh_user` revoked; SECURITY DEFINER lookups pin `search_path` (`standalone_002_users.sql:31-45`); RLS enabled on all managed tables with org-visibility policies and service-role DML (`standalone_001_schema.sql:1462-1475,1492-1494`); `scripts/verify-standalone-security.js` confirms role attributes, cross-org denial, and audit tamper denial.
- Request GUC ordering: in standalone the `OrgContextInterceptor` wraps the handler in the same transaction that sets `app.user_id/current_org_id/current_org_ids/is_global_admin` (`org-context.interceptor.ts:66-78`, `request-database-context.ts:39-47`); guards do not touch the DB, so ordering is correct; RLS fails closed when GUCs are absent.
- Audit chain: per-org SHA-256 chain with `pg_advisory_xact_lock` serialization, append-only via `ewoh_append_audit_log` (SECURITY DEFINER, org-visibility checked), no UPDATE/DELETE grants on `ewoh_audit_log` (`standalone_001_schema.sql:1390-1442,1492-1494,1602`); app-level redaction of sensitive keys/credential strings before persist (`modules/shared/audit.service.ts:37-70,103-152`).
- Files: UUID validation before any storage path use (`file.service.ts:66-70`), org-scoped access checks (`file.service.ts:72-76`), upload size/field limits and MIME allowlist (`file.controller.ts:24-32`), S3 keys derived only from the server UUID (`s3-storage.driver.ts:106-112`); attachment Content-Disposition mitigates stored-content XSS.
- CORS: unset `CORS_ORIGINS` disables CORS (`origin: false`) and `*` is rejected (`standalone-main.ts:15-23`) — fail-closed.
- Deploy: compose requires secrets via `${VAR:?}` (`docker-compose.standalone.yml`), k8s uses runAsNonRoot + drop ALL capabilities + seccomp (`migration-job.yaml`, `api-deployment.yaml`); `.env`/`.env.local` are ignored in the outer repo (`.env` tracked only inside `ewoh-spark-app`, see suggestion above).
- Tests: 20 targeted suites / 47 tests pass (auth, guards, audit, files, system).

## Recommendation

`fix_required` — address the 4 major findings (controller-level RBAC enforcement, refresh-token rotation/revocation, rate-limit scoping behind proxies, system-config upsert constraint) before production rollout; then close the minors. Re-run `scripts/verify-standalone-security.js` against a fresh standalone database after fixes, extended with API-level negative tests.
