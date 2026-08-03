# EWOH Persistence & Tenant-Boundary Audit — 2026-08-03

Scope: `ewoh-spark-app/server/modules/**`, `ewoh-spark-app/server/database/**`, `db/migrations/standalone_*.sql`, `db/verify/standalone_001_verify.sql`, `deploy/**`, `test/scenarios/scenario-packages.spec.ts`, `test/unit/**`.
Method: static inspection (`rg`/`sed`/`cat`), plus `npx jest test/scenarios/scenario-packages.spec.ts --runInBand` (8/8 pass, 7.4 s). No source files modified.

## 1. Persistence classification by module

Legend:
- **PG-context** = real PostgreSQL via request-scoped database context (Drizzle on `@server/database/schema` or raw SQL) with RLS/GUC scoping applied by `OrgContextInterceptor`.
- **PG-schema** = Drizzle schema (`database/schema.ts`) / migration tables used.
- **MEM** = in-memory only (state lost on restart, no tenant boundary).
- **MIX** = mixed.

| Module | Class | Evidence |
|---|---|---|
| dashboard | PG-context (Drizzle) | `dashboard.service.ts:37` injects `DRIZZLE_DATABASE` (request-scoped proxy); reads/writes on `ewohDevice/ewohEvent/ewohTelemetry/ewohSpatialEntity/ewohDeviceBinding`; NO app-side org filter (`dashboard.service.ts:55-75,459-504`); relies entirely on RLS + GUC |
| ingest | PG-context (Drizzle) | `ingest.service.ts:53-58`; inserts telemetry/environment/world_state/spatial_entity/device/event (`:160,:200,:254,:337,:388,:478,:526`); HTTP path → interceptor transaction |
| rule-engine | PG-context when called from HTTP ingest; **broken from simulator tick** | `rule-engine.service.ts:25`; event+chain inserts `:150,:168`; in-memory dedup map `:34-36` |
| scheduler | PG-context (Drizzle), request-driven | `scheduler.service.ts:28`; plans/audit insert+update `:140,:196,:207,:449`; `weightHistory` in-memory `:44-46`; no `onModuleInit` background job |
| simulator | MIX — in-memory runtime + DB writes **outside request scope** | `simulator.service.ts:101-131` (`onModuleInit` → `setInterval` ticks); writes `:381,:465,:478,:493,:536,:561,:573` via `this.db` with NO GUC/transaction → RLS blocks/fails (see Finding C1) |
| spatial | PG-context (read-only Drizzle) | `spatial.service.ts:11,42-89` (selects only) |
| world | PG-context (read-only Drizzle) | `world.service.ts:14`; selects from spatial_entity/world_state/event/event_chain |
| world-cursor | MEM | `world-cursor.service.ts:60-62` (`Map` + in-memory deltaLog); migration tables `ewoh_world_snapshot`/`ewoh_world_delta_log` (`standalone_001_schema.sql:956,976`) unused |
| gamification | PG-context (Drizzle) + in-memory role maps | `gamification.service.ts:38`; writes `ewohSchedulePlan`/`ewohScheduleAudit` `:216,:239,:351,:374`; no org filter app-side |
| organization | PG-context (Drizzle) + audit; org tree built in-memory | `organization.service.ts:78-97`; only module that calls `AuditService.appendAuditLog` (`:112`); optional `orgId` filter on personnel `:205-206` |
| model | PG-context (Drizzle) | `model.service.ts:32`; TOCTOU transition `:74-79` |
| system | PG-context (Drizzle) | `system.service.ts:24`; `ewohSchedulerConfig` global unique `config_key` vs org-scoped RLS (Finding M2) |
| task | PG-context (Drizzle) | `task.service.ts:58`; TOCTOU transition `:105-111`; no audit |
| alert | PG-context (Drizzle) | `alert.service.ts:23`; TOCTOU transition `:44-49`; no audit |
| control | MEM | `control.service.ts:64-65` (`requests`/`byIdempotency` Maps); migration tables `ewoh_control_request/command/result` (`standalone_001_schema.sql:846-912`) unused |
| approval | MEM | `approval.service.ts:44` (`instances` Map); no DB tables at all |
| resource | MEM | `resource.service.ts:26-27` (inventory/preorders Maps); migration tables `ewoh_resource_preorder/ewoh_resource_binding` (`standalone_001_schema.sql:793,818`) unused |
| ai | MIX — MEM by default; raw SQL when db present | `ai.service.ts:63-64` (Maps); raw SQL on `ewoh_ai_suggestion` `:95-160`; no org filter app-side |
| audit | PG (query) + DB sink; writes only from organization module | `audit.service.ts:59` (queries `ewoh_audit_log`); `database-audit-sink.ts:20-38` calls `ewoh_append_audit_log` (SECURITY DEFINER, hash chain, org check) — see Finding M3 |
| auth | PG via SECURITY DEFINER function | `auth.service.ts:39,127`; `ewoh_find_active_user` SECURITY DEFINER (`standalone_002_users.sql:31-47`); RLS on `ewoh_user`; no token revocation |
| files | Not DB — storage drivers (local disk / S3); app-side org boundary | `file.service.ts:29-45,76` (org filter by `access.orgId`); metadata JSON on disk (`local-storage.driver.ts:10-20`) |
| health | PG ping (read-only) | `health.controller.ts` + db.execute |

## 2. Tenant-boundary / transaction / audit / state-machine checks

- **GUC + transaction design exists**: `OrgContextInterceptor` wraps authenticated HTTP handlers in `RequestDatabaseContext.runInTransaction` with `set_config(..., true)` (`org-context.interceptor.ts:71-80`; `request-database-context.ts:31-47`). RLS policies `ewoh_org_select` (authenticated) / `ewoh_service_all` (service_role) gate every row by `ewoh_org_visible(org_id)` (`standalone_001_schema.sql:1467-1494`); runtime role `ewoh_api` is NOBYPASSRLS member of `service_role` (`standalone_003_runtime_role.sql:9-15`). Verified by `db/verify/standalone_001_verify.sql:27-90`.
- **No app-layer org filter on any Drizzle query**; `database/schema.ts` has NO `org_id` columns on any of its 18 tables. Boundary = RLS only. Any path that runs without GUCs is either fully blocked (fail-closed) or, if RLS is off/bypassed, fully cross-tenant (fail-open).
- **Org hierarchy is dead code**: `OrgScopeService` (`org-scope.service.ts:37-146`) is registered/exported but never injected by any module; `AccessTokenGuard` sets `accessibleOrgIds: [payload.orgId]` only (`access-token.guard.ts:44-46`), so `app.current_org_ids` never includes descendant orgs.
- **Audit**: `AuditService` + `DatabaseAuditSink` registered (`shared.module.ts:16-17`); only `organization.service.ts:112` emits audit entries. `AuditChainService` is an in-memory Map used only by tests.
- **State-machine guards**: `StateMachineGuard` exists (`state-machine.guard.ts`) but `@StateMachine` is used nowhere (rg: 0 hits) and the guard is not registered globally. Transitions are enforced app-side by read-then-write with no conditional `WHERE status = ...` (see Finding M4).

## 3. Scenario test realism — SP-01..SP-08

`test/scenarios/scenario-packages.spec.ts` (ran: 8/8 pass, 7.4 s). **No SP is a real HTTP+DB test.** All instantiate services directly with in-memory state or pure functions; DB-touching services are constructed without a database.

| Scenario | Claimed | Actual | Class |
|---|---|---|---|
| SP-01 person/exo safety | org tree + risk + alert | `buildOrgTree`, `coarseHealthRisk`, `nextAlertStatus` pure functions (`:12-17`) | unit-mocked |
| SP-02 task scheduling | task + preorder + approval | `new ResourceService()`, `new ApprovalService()` (in-memory), `nextTaskStatus` loop (`:19-34`) | unit-mocked |
| SP-03 AI decision | A2/A3 flow | `new AiService()` with no db → in-memory Maps (`:36-43`) | unit-mocked |
| SP-04 device control | retry/idempotency | `new ControlService()` in-memory (`:45-53`) | unit-mocked |
| SP-05 digital world | snapshot/delta/cursor | `new WorldCursorService()` in-memory (`:55-61`) | unit-mocked |
| SP-06 multi-org isolation | per-org audit chains | `new AuditChainService()` in-memory Map (`:63-69`); does NOT exercise RLS/GUC | unit-mocked |
| SP-07 audit tamper | hash chain | in-memory chain mutation (`:71-78`) | unit-mocked |
| SP-08 release/rollback | DDL runner | real subprocess `run_migrations.js --plan` for 9 targets — real execution but **plan mode only, no DB connection, no HTTP** (`:80-118`) | partial (DDL-plan smoke) |

`test/unit/**` similarly uses `jest.fn()` mock databases everywhere (e.g., `ai/ai.service.spec.ts:41-43`, `shared/database-audit-sink.spec.ts:5`, `auth/auth.service.spec.ts:32`). Nothing asserts RLS behavior, GUC propagation, org isolation, or transaction rollback against a real Postgres. The org-scoping contract (`db/verify/standalone_001_verify.sql`) is only verified via `--plan` text output (SP-08), never executed against a live DB.

## 4. Severity-ranked findings

### C1. CRITICAL — Simulator background loop writes outside the request-scoped GUC transaction; under standalone RLS all its DB writes fail and reads return empty (silent)
- Evidence: `simulator.service.ts:101-131` (`onModuleInit` → `setInterval` ticks), `:381` (`db.insert(ewohTelemetry)`), `:465` (`db.insert(ewohWorldState)`), `:478,:493` (device upsert), `:536` (environment), `:561,:573` (event/chain via rule engine); `request-database-context.ts:24-26` (proxy falls back to `rootDatabase` when no ALS store → no GUCs); `standalone_001_schema.sql:1467-1475` (RLS `ewoh_service_all ... USING/WITH CHECK ewoh_org_visible(org_id)`), `:1289-1306` (`org_id SET NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true),'')::uuid)`).
- Impact: with GUCs unset, `ewoh_org_visible` returns false → every background SELECT returns 0 rows and every INSERT violates `org_id NOT NULL`/`WITH CHECK`. Errors are swallowed (`catch + logger.error`, `:368-389,:425-440`), so the core simulated telemetry/world-state/event pipeline silently produces no data in production standalone. Any future background job (scheduler cron, rule engine offload) hits the same trap.
- Fix: wrap background work in `requestDatabaseContext.runInTransaction(buildGucSettings({...system or default org...}), ...)`, or run background jobs under an explicit org context; at minimum surface a health/error counter instead of swallowing failures.

### C2. CRITICAL — Legacy deployment path (the default in `main.ts`) has no authentication, never sets `userContext`, and therefore never applies org GUCs; tenant isolation silently collapses to whatever the DB role allows
- Evidence: `main.ts:33-39` (legacy unless `EWOH_DEPLOY_TARGET=standalone`/`STANDALONE=1`); `app.module.ts:49-58` registers only `RolesGuard` (no `AccessTokenGuard`) in legacy; `access-token.guard.ts:44` is the only place `request.userContext` is set; `org-context.interceptor.ts:68-71` skips entirely when `userContext` is absent; fallback path `applyGucSettings` (`:88-91`) runs `set_config(..., true)` on a pooled connection where the transaction-local GUC evaporates before the next statement → useless by design. Files endpoints then throw 400 (`file.controller.ts:126-131`); every other endpoint is unauthenticated and unscoped (if the legacy DB role bypasses RLS, full cross-tenant access; if not, everything returns empty).
- Fix: make standalone the only path (fail fast in legacy bootstrap unless a supported legacy DB/auth is explicitly configured), or register `AccessTokenGuard` globally in `AppModule` and provide `RequestDatabaseContext` there; remove the misleading `applyGucSettings` fallback.

### M1. MAJOR — Claimed scenario coverage is not real: no SP-01..SP-08 test exercises HTTP + Postgres; the RLS/GUC/tenant contract is untested
- Evidence: `test/scenarios/scenario-packages.spec.ts` (see table above); mocked unit tests (`ai/ai.service.spec.ts:41-43`, `shared/database-audit-sink.spec.ts:5`). `db/verify/standalone_001_verify.sql` is never executed against a live DB in CI/tests.
- Impact: regressions in the exact areas this audit targets (RLS scoping, GUC propagation, transaction rollback, org isolation, audit chain) would pass CI.
- Fix (smallest): add one integration suite that boots `StandaloneAppModule` against a disposable Postgres (e.g., testcontainers or a dedicated CI service), logs in as two orgs, and asserts cross-org invisibility + write failure without GUCs; keep SP-01..SP-08 as-is but rename/relabel as unit smoke.

### M2. MAJOR — State-machine transitions are read-then-write with no conditional update; concurrent requests can violate the state machine; the dedicated `StateMachineGuard` is unused
- Evidence: `task.service.ts:105-111` (read task → compute `nextTaskStatus` → `update ... where id`), `alert.service.ts:44-49`, `model.service.ts:74-79`, `scheduler.service.ts:192-210` (`confirmPlan` checks `status === 'confirmed'` then unconditional update; also inserts audit in a separate statement — not atomic with the update); `@StateMachine` has 0 usages (rg).
- Impact: two racing transitions (e.g., `complete` and `cancel` from `executing`, or double `confirm`) both pass the read check; last-write-wins corrupts state; confirm + audit write can diverge on failure.
- Fix: add `where(eq(status, current))` and retry/error on 0 rows updated; wrap confirm+audit in one transaction; either delete `StateMachineGuard` or actually apply it at the DB layer (assert current state inside the transaction).

### M3. MAJOR — Audit coverage is nearly absent: only the organization module writes to the audit chain; all other write paths (task/alert/device/plan/telemetry/events/config) are un-audited
- Evidence: `organization.service.ts:112` is the sole `appendAuditLog` caller (rg); `audit-chain.service.ts:15-16` in-memory, used only by tests; `database-audit-sink.ts:20-38` exists and is registered but unreached.
- Impact: no tamper-evident record for who changed device state, confirmed plans, tasks, alerts, or system config — the audit contract (`ewoh_append_audit_log` hash chain, `standalone_001_schema.sql:1382-1433`) is effectively unused.
- Fix: route high-risk mutations (confirm/dispatch, device lifecycle, task/alert transitions, config writes) through `AuditService.appendAuditLog` inside the same request transaction; add a test that asserts a DB audit row is produced.

### M4. MAJOR — Tenant boundary is RLS-only with zero app-layer org filtering and an org-schema that omits `org_id`; `OrgScopeService` hierarchy resolution is dead code
- Evidence: `database/schema.ts` (18 tables, no `org_id` anywhere); `dashboard.service.ts:55-75`, `scheduler.service.ts:34-54`, `gamification.service.ts:216-240`, `task.service.ts:80-89`, `ingest.service.ts:160-176` (no org conditions); `access-token.guard.ts:44-46` (accessibleOrgIds = [primaryOrgId]); `org-scope.service.ts` never injected (rg: 0 references outside shared).
- Impact: any misconfiguration that disables RLS or loses GUCs (C1/C2 paths) exposes all orgs' data with no second line of defense; parent orgs cannot manage descendants (fail-closed but feature-broken); the org hierarchy machinery is unused.
- Fix: regenerate/add `org_id` to the Drizzle schema and add `inArray(orgId, accessibleOrgIds)` filters on all list/get queries (cheap, keeps RLS as backstop); wire `OrgScopeService` into `AccessTokenGuard` so `accessibleOrgIds` includes resolved descendants.

### M5. MAJOR — Safety/operations state is in-memory only for control/approval/resource/world-cursor while the DB schema for these exists (control/resource/world) and is unused
- Evidence: `control.service.ts:64-65` (no DB; migration tables `ewoh_control_request/command/result` at `standalone_001_schema.sql:846-912`); `approval.service.ts:44` (no tables); `resource.service.ts:26-27` (tables at `:793-818`); `world-cursor.service.ts:60-62` (tables at `:956-988`).
- Impact: control requests (device commands), approvals, resource preorders, and world deltas vanish on restart and across replicas; no tenant isolation or audit for these; command replay after a crash is impossible (safety-relevant for an embodied-factory control plane).
- Fix: persist control requests/results to `ewoh_control_*` (idempotency key already unique per org in the migration), approvals to a new org-scoped table, preorders to `ewoh_resource_preorder`, and world snapshots/deltas to the existing tables; add org_id via the GUC default as designed.

### m1. MINOR — `ewoh_scheduler_config.config_key` is globally unique while the table is org-scoped → cross-org conflict/overwrite
- Evidence: `database/schema.ts:298-313` (unique `config_key`); `system.service.ts:57-71` (`onConflictDoUpdate` targeting `configKey`); `standalone_001_schema.sql:1469-1475` (RLS on the table).
- Impact: org B cannot set a key used by org A (conflict on the global unique index; update of org A's row is blocked by RLS); a global admin could overwrite another org's config.
- Fix: make the unique index `(org_id, config_key)` and set `updatedBy` from the request GUC.

### m2. MINOR — Legacy fallback GUC path is a functional no-op and misleading
- Evidence: `org-context.interceptor.ts:88-91` (`set_config(..., true)` via pooled `db.execute` — transaction-local, lost on connection release).
- Impact: any future "authenticated" path that bypasses `runInTransaction` silently loses org context (fail-open if RLS off).
- Fix: delete the fallback; require `RequestDatabaseContext` in the interceptor constructor.

### m3. MINOR — Rule-engine event dedup is process-local; scheduler plan generation is not idempotent; scheduler weights history is in-memory
- Evidence: `rule-engine.service.ts:34-36` (`lastEventTriggered` Map); `scheduler.service.ts:44-46` (`weightHistory`), `:140-148` (unconditional insert on each `POST /plans`).
- Impact: duplicate events across replicas/restarts; duplicate plans on double-submit; weight change history lost.
- Fix: move dedup window into DB (e.g., `ewoh_event` `trigger_record_id` unique per rule) and make plan generation idempotent via a deterministic plan key.

### m4. MINOR — Auth session hygiene: refresh tokens are never revoked or rotated; no per-user session table
- Evidence: `auth.service.ts:104-121` (`issue` — stateless JWTs, `expiresIn` only); no revocation on password change.
- Impact: leaked refresh token is valid for 30 days regardless of password change.
- Fix: add a sessions table (org-scoped, RLS) keyed by token jti with revoke-on-password-change.

### i1. INFO — Drizzle schema drift: `database/schema.ts` is generated from the legacy workspace (e.g., `_created_by` as `user_profile` composite) while the standalone migration uses `uuid` columns; `schema.ts` also lacks `org_id`
- Evidence: `database/schema.ts:16-25` (`userProfile` custom type), `:153-182` (no `org_id`); `standalone_001_schema.sql:1116-1117` (`_created_by uuid DEFAULT NULL`).
- Impact: drizzle-kit cannot be used against the standalone DB; future inserts referencing `createdBy/updatedBy` will emit `user_profile` casts that do not exist there.
- Fix: regenerate `schema.ts` from the standalone DDL (or maintain a standalone-aligned schema file) and add `org_id` columns.

### i2. INFO — Personnel `org_id` varchar→uuid migration nulls non-UUID legacy values
- Evidence: `standalone_001_schema.sql:1230-1242` (`CASE WHEN org_id ~ '^[0-9a-fA-F-]{36}$' THEN org_id::uuid ELSE NULL END`).
- Impact: legacy varchar org ids are silently dropped to NULL (then backfilled to default org on the 18-table backfill only if matched there — personnel is excluded from the backfill list at `:1263-1280`). Verify seed/legacy data before applying.
- Fix: map legacy org values to UUIDs explicitly in the migration or add personnel to the backfill.

### i3. INFO — Repo-root `demo.db` (109 MB SQLite) is unrelated to the Postgres-backed app and risks being mistaken for app state
- Evidence: `demo.db`/`demo.db-shm`/`demo.db-wal` at repo root (109,531,136 bytes).
- Fix: document or remove; add to `.gitignore`.

## 5. Recommended verification order
1. Fix C1/C2 (org context for background jobs; kill the unauthenticated legacy default).
2. Add the integration suite (M1) that proves RLS isolation and GUC propagation against a real Postgres with `ewoh_api`.
3. Add conditional-update state transitions (M2) and wire audit (M3).
4. Persist control/approval/resource/world-cursor state (M5), then re-run SP-01..SP-08 as integration-level scenarios.

— Compiled by independent verification agent, 2026-08-03. Only file written: this report.
