---
workItemIds: [T-011, T-012, T-013, T-014, T-015, T-016, T-017, T-018, T-019, T-020]
kind: test
result: passed
commitSha: dee6503effd7c4cea76dbb1d7ce30054d366f0cb
branch: main
buildVersion: 0.6.0-rc4
envFingerprint: 5fe7c6feb11e2726634abc7e27cd90a86f694b21422960b4c3d7f6c71d1facce
dependencyVersion: 3:2.2.5
producedAt: 2026-08-04T05:35:50.594Z
expiresAt: 2026-11-02T05:35:50.594Z
verifier: "EWOH independent verification agent"
---

# EWOH Round 2 Execution Evidence

Date: 2026-08-03

## Completed

- Registered OrgContextInterceptor as global APP_INTERCEPTOR.
- Ran project codegen to sync `server/database/schema.ts` with the live
  workspace schema: 18 tables, custom user_profile/file_attachment preserved.
- Implemented Organization/Personnel domain module:
  - GET/POST/PATCH `/api/organization`, GET `/api/organization/tree`
  - GET/POST/PATCH `/api/personnel`, GET `/api/personnel/:id`,
    GET `/api/personnel/:id/bindings`
  - pure helpers `buildOrgTree` and `coarseHealthRisk`
- Added client `api/organization.ts`, real CommandCenter and Personnel pages.
- Added Jest moduleNameMapper for `@server/*` and `@shared/*`.
- Added device search endpoint `/api/dashboard/devices/search` with pagination
  and available filters (keyword, online, battery, source, model, firmware,
  protocol, fault, binding bound/unbound).
- Added model registry module `api/models` with candidate/review/shadow/active/
  retired transition helper and tests.
- Added global RolesGuard and `/api/personnel/:id/sensitive` restricted to
  safety_admin/global_admin.
- Added system config module `api/system/config` with credential masking.
- Added task state machine service (`api/tasks`) persisted to
  `ewoh_production_task`.
- Added alert state machine service (`api/alerts`) persisted to `ewoh_event`.
- Added control request service (`api/control/requests`) with retry attempts,
  idempotency, and latest-attempt aggregation.
- Added approval instance/step service (`api/approvals`) with bypass, cancel,
  delegate, skip, and expiry.
- Added resource preorder service (`api/resource/preorders`) with reservation
  math that prevents overselling and supports issue/release.
- Added AI decision service (`api/ai`) where A2 suggestions and A3 plans are
  only created on manual trigger; no pre-generation on initialization.
- Added world snapshot/delta cursor service (`api/world/snapshot|delta`) with
  base64 cursor, incremental upserts/removals, and 410 cursor expiry.
- Upgraded Scheduling, Alerts, AI Decision, Model Management, and System pages
  from placeholders to real API-backed pages.
- Added SHA-256 audit hash chain service with per-org continuity verification.
- Added automated scenario suite covering SP-01 through SP-08.
- Added Digital World, Organization, and Data Assets pages backed by spatial,
  world, organization, model, and system APIs; all 11 centers now have real or
  API-backed pages.
- Ran `make lint-fix`: 115 Python lint errors auto-fixed, remaining debt down
  from 609 to 490; 667 unittest and 53 contract tests still pass.
- Ran `ruff check --fix --unsafe-fixes`: further reduced Python lint debt to
  116 remaining; 667 unittest and 53 contract tests still pass.
- Fixed correctness lint (F821 undefined name in replay script, B904
  raise-from, E741 ambiguous names, B007 unused loop var), then ran
  `ruff format`; Python lint debt now 96 remaining (88 UP031 + 8 E501).
- Ran `flynt` to convert safe `%` formatting to f-strings and re-ran ruff
  format/fix; Python lint debt is now 76 (68 UP031 + 8 E501), with 667
  unittest and 53 contract tests still passing.
- Added delivery docs: deployment runbook, release checklist, acceptance
  evidence, and training plan under `docs/delivery/`.
- Added demo seed SQL (`db/seed/001_demo_seed.sql`) and runner `--seed` plan
  support; scenario SP-08 now also verifies `--plan seed`.
- Added Command Map L3 (workstation/device close-up) and L4 (person/exo
  follow) views with level cycle L0-L4.
- PIVOT to standalone cloud product: added cloud-production architecture doc,
  standalone NestJS bootstrap (no Miaoda PlatformModule), standard env
  contract, Dockerfile, and Docker Compose. Standalone server verified on
  :3100 with /health, SPA root, and /api/models returning 200.
- M2 client decoupling: active client API files use standard axios via
  `client/src/lib/http.ts`; standalone Vite config produces `index.standalone.html`
  with EWOH title and no Feishu CDN; standalone server serves it at `/`.
- M2 auth: standalone JWT AuthModule with login/refresh/me, JWT middleware
  populating `req.userContext`, verified on :3100; sensitive route returns 403
  without token.
- M2 UI: standalone `/login` page stores tokens and axios attaches Bearer;
  `/login` returns 200 in standalone build.
- M4/M5: added Kubernetes manifests (3 replicas, HPA 3-12, PDB min 2,
  ingress, probes) and RedisService/RateLimitGuard with in-memory fallback;
  standalone `/health` and `/api/models` remain 200.
- Added `ewoh_user` migration/seed and bcrypt-backed AuthService DB lookup with
  bootstrap-user fallback; runner supports `--plan users` / `--plan users_seed`.
- Added standalone CI/CD workflow and concurrency smoke script; local evidence:
  `/health` 500 req/100 concurrency = 6794 qps, p95 21.77ms;
  `/api/models` 300 req/100 concurrency = 255 qps, p95 154.14ms.
- Added standalone DDL generator: transforms schema to `public`, replaces
  `user_profile` with `uuid`, rewrites roles to `authenticated/service_role/anon`;
  runner plans for standalone schema/seed/users/admin verified with zero
  `user_profile` or workspace tokens.
- Added `scripts/standalone-check.sh` and ran it end-to-end: type check, lint,
  54 Jest tests, standalone production build, DDL plans, and DDL hygiene all
  passed.
- Added local file service (`api/files`) with upload/list/download/delete;
  roundtrip verified on :3100.
- Added UUID validation helper and applied it to organization personnel,
  production task, and model registry entry points; invalid UUIDs now return
  404 instead of surfacing PostgreSQL 22P02 as 500. Full Jest run: 56 tests /
  25 suites pass, type check and lint pass.
- Added pluggable file storage drivers: local disk fallback and
  S3-compatible object storage (AWS SDK v3). Object keys use
  `files/<uuid>` plus a `files/<uuid>.meta.json` sidecar so replicas stay
  stateless; `OBJECT_STORAGE_*` env contract is wired into
  `.env.standalone.example`, Docker Compose, and Kubernetes manifests.
- Added S3 driver unit tests and file ID UUID guard; full Jest run: 59 tests /
  26 suites pass, type check and lint pass.
- Live standalone smoke on `:3101`: upload, metadata read, byte-identical
  download, and delete all succeeded with the new storage driver; a 404 is
  returned after deletion. Full `scripts/standalone-check.sh` passes
  (type/lint/Jest/build/DDL).
- Restarted the standalone API on `:3100` with the new build and repeated the
  file upload/download/delete smoke successfully.

## Verification

- `npm run type:check` pass
- `npm run lint` pass
- `npm test`: 51 passed / 21 suites
- NestJS dev watch compiles with 0 errors
- API routes registered and return 403 behind auth/CSRF (expected)

## Remaining W2

- Device 19-dimension search/config after DDL fields exist.
- Spatial/data governance domain services.
- Role-aware sensitive health access.
- Live DDL still blocked by DB CREATE privilege.
