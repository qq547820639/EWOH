# EWOH Task Board

Lifecycle: Proposed -> Refining -> Ready -> Claimed -> In Progress -> Blocked
-> Review -> Validation -> Integrated -> Done | Rejected.

## Wave W0 - Baseline, Contracts, Probes (current)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-001 | Read authoritative docs | AG-00 | Done | `.codex/artifacts/authoritative-plan.txt`, `final-implementation-plan.txt` |
| T-002 | Repo/module/table inventory | AG-00 + explorers | In Progress | `inventory/*.md` |
| T-003 | Environment probes | AG-10 | In Progress | `inventory/environment.md` |
| T-004 | C1 data contract | AG-03 | Refining | `contracts/data-contract.md` |
| T-005 | C2 API contract | AG-04 | Refining | `contracts/api-contract.md` |
| T-006 | C3 state machines | AG-05 | Refining | `contracts/state-machines.md` |
| T-007 | C4 security contract | AG-06 | Refining | `contracts/security-contract.md` |
| T-008 | C5 UI contract | AG-30 | Refining | `contracts/ui-contract.md` |
| T-009 | C6 DevOps contract | AG-51 | Refining | `contracts/devops-contract.md` |
| T-010 | Requirements traceability | AG-01/41 | Refining | `contracts/requirements-trace.md` |
| T-011 | Logical capability -> physical table map | AG-03/10 | Refining | `contracts/data-contract.md` |
| T-012 | Baseline test harness fix | AG-10/51 | Validation | `inventory/environment.md`, Makefile, package.json, test.yml |
| T-013 | DDL/migration package generation | AG-10 | Validation | `db/`, `tmp/ddl/`, runner plan mode OK; live DDL pending |
| T-014 | Backend shared infrastructure | AG-11 | Validation | 7 Jest suites / 18 tests pass; type check pass |
| T-015 | Frontend 11-center shell | AG-30 | Review | 11 routes, grouped Layout, placeholders, namespaces, queryKeys |

## Wave W2 - Master Data Domains (started)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-016 | Drizzle schema codegen sync to live DB (18 tables) | AG-10/codegen | Done | `server/database/schema.ts` 556 lines, type check pass |
| T-017 | Organization/personnel backend module | AG-12 | Validation | `server/modules/organization/`, 2 tests, type check pass |
| T-018 | Command center + personnel real-data pages | AG-31/32 | Review | CommandCenter/Personnel pages fetch APIs, type check pass |
| T-019 | Device search extension (available fields + pagination + binding filter) | AG-13 | Validation | `/api/dashboard/devices/search`, 2 tests |
| T-020 | Model registry management module | AG-15 | Validation | `/api/models`, lifecycle transition tests |
| T-021 | Role guard + sensitive personnel endpoint | AG-06/12 | Validation | `@Roles` guard, `/api/personnel/:id/sensitive`, tests |
| T-022 | System config module with credential masking | AG-21 | Validation | `/api/system/config`, masking tests |

## Wave W3 - Operations Loop (started)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-023 | Task state machine service | AG-16 | Validation | `api/tasks` + transitions tests |
| T-024 | Alert state machine service | AG-18 | Validation | `api/alerts` + transitions tests |
| T-025 | Control request aggregation service | AG-19 | Validation | `api/control/requests`, latest-attempt aggregation tests |
| T-026 | Approval instance/step service | AG-18 | Validation | `api/approvals`, step aggregation tests |
| T-027 | Resource preorder/issue/release | AG-17 | Validation | `api/resource/preorders`, no-oversell math tests |
| T-028 | AI manual suggestion/plan service | AG-20 | Validation | `api/ai`, no pre-generation, structured output tests |
| T-029 | World snapshot/delta cursor protocol | AG-14 | Validation | `api/world/snapshot|delta`, 410 expiry tests |
| T-030 | Scheduling/Alerts/AI/Model/System real pages | AG-31/33/34/35 | Review | pages fetch real APIs; type check + lint pass |

## Wave W5 - Scenario and Independent Validation (started)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-031 | Audit hash chain service | AG-06 | Validation | SHA-256 per-org chain, tamper detection tests |
| T-032 | SP-01..SP-08 scenario smoke suite | AG-50 | Validation | `test/scenarios/scenario-packages.spec.ts` passes |
| T-033 | DigitalWorld/Organization/DataAssets real pages | AG-31/32/35 | Review | pages fetch spatial/world/org/model/system APIs |
| T-034 | Delivery docs: runbook/release/acceptance/training | AG-51/52 | Review | `docs/delivery/*.md` |
| T-035 | Demo seed SQL + runner --seed | AG-10/50 | Validation | `db/seed/001_demo_seed.sql`, runner plan seed |
| T-036 | Command Map L3/L4 views | AG-31 | Validation | L3 workstation close-up, L4 person follow; type/lint pass |

## Wave Cloud - Standalone Product (started)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-037 | Standalone NestJS bootstrap without Miaoda PlatformModule | AG-11 | Validation | `/health` 200, `/` 200, `/api/models` 200 on 3100 |
| T-038 | Standard env contract + Docker Compose | AG-51 | Validation | `.env.standalone.example`, `deploy/cloud/*` |
| T-039 | Client HTTP layer without Miaoda toolkit | AG-30 | Validation | standard axios lib, standalone Vite config, no Feishu CDN in HTML |
| T-040 | JWT auth for standalone | AG-06/11 | Validation | /api/auth/login/refresh/me; roles guard enforced |
| T-041 | Standalone login page + token storage | AG-30 | Validation | `/login` 200, axios attaches Bearer |
| T-042 | Kubernetes/HA manifests | AG-51 | Validation | deployment/service/ingress/HPA/PDB |
| T-043 | Redis service + rate limit guard | AG-11/46 | Validation | ioredis with memory fallback; 429 guard test |
| T-044 | ewoh_user migration + seed | AG-10 | Validation | `002_ewoh_users.sql`, `002_default_admin.sql`, runner plans |
| T-045 | DB-backed auth with bcrypt | AG-06/11 | Validation | AuthService queries ewoh_user, bcrypt compare, env fallback |
| T-046 | Standalone CI/CD workflow | AG-51 | Validation | `.github/workflows/standalone.yml` |
| T-047 | Concurrency smoke script + evidence | AG-46 | Validation | `scripts/perf-smoke.js`; /health 6794 qps, /api/models 255 qps |
| T-048 | Standalone standard DDL variant | AG-10 | Validation | generator + runner plans; no user_profile/workspace tokens |
| T-049 | One-click standalone check script | AG-51 | Validation | `scripts/standalone-check.sh` passes end-to-end |
| T-050 | File service (upload/download/delete) | AG-21 | Validation | `/api/files` roundtrip verified on :3100 |
| T-051 | UUID input robustness (404 instead of DB 22P02 500) | AG-11/12/16/15 | Validation | `server/common/uuid.ts`; org/task/model guards; 56 tests / 25 suites pass |
| T-052 | S3-compatible object storage driver | AG-21 | Validation | local + S3 drivers, env contract, compose/k8s wiring; live upload/download/delete on :3101; 59 tests / 26 suites pass |
| T-053 | Strict standalone auth and request-scoped DB context | AG-06/11 | Done | bcrypt-only auth, HS256 payload/type validation, fail-closed DB lookup, ALS transaction/GUC context; 76 tests / 31 suites pass |
| T-054 | PostgreSQL 17 standalone migration/security/rollback gate | AG-10/41 | Done | PG 17.10 apply/verify/idempotency/RLS/audit/rollback/rebuild pass; 53/53 request org defaults present |
| T-055 | HTTP multi-organization authorization acceptance | AG-41 | Done | `:3101` runtime-role service: health 200, unauth 401, token-type rejection, A/B isolation, global read, auto `org_id` all pass |
| T-056 | OpenAPI/controller route drift audit | AG-04/41 | Validation | reusable audit script; 102 controller vs 36 spec operations, 69 undocumented and 3 unimplemented |
| T-057 | DB-backed audit chain sink + read-only audit API | AG-06/41 | Done | `ewoh_append_audit_log` sink, `GET /api/audit` pagination/filter, org write instrumentation; live create/update audit + per-org isolation passed |

## Wave W5 Hardening (WP-HARDEN-001, in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-058 | Independent security/persistence/frontend reviews | AG-40/41/44 | Done | three reports in `.codex/artifacts/work/reviews/` |
| T-059 | Security hardening: RBAC, refresh rotation/logout, rate limit, config unique index, audit roles, k8s config | AG-06/11 | Validation | WP-HARDEN-001 H-01; tests + DB verify pass |
| T-060 | Runtime context/state machines: legacy auth fail-fast, simulator GUC, conditional transitions, audit wiring | AG-11/16/18/15 | Validation | WP-HARDEN-001 H-02; 121 Jest tests pass |
| T-061 | Persist control/resource/world-cursor to existing tables; approval gap documented | AG-17/19/14 | Validation | WP-HARDEN-001 H-03; 121 Jest tests pass |
| T-062 | Frontend/command map majors: event drill-down, real replay, role nav/guard, 401 refresh, 3D mode/fallback | AG-30/31/44 | Validation | WP-HARDEN-001 H-04; typecheck/build/client tests pass |
| T-063 | Real HTTP+PostgreSQL E2E scenario suite | AG-50/41 | Validation | `test/e2e/ewoh-http.e2e.spec.ts`; 9/9 pass on local PostgreSQL |
| T-064 | Browser UI regression: QueryClient provider fix + world replay 500 fix | AG-30/44 | Validation | Playwright login/command-center/command-map/devices/alerts pass; `/api/world/replay` 200 |
| T-065 | OpenAPI 106-route DTO contract | AG-04 | Done | `openapi/ewoh.yaml` 93 paths / 106 ops; strict audit 0/0; C2 v1.0 frozen |
| T-066 | Approval persistence via event/event_chain/audit equivalent mapping | AG-18 | Done | ApprovalPersistenceService; C1 mapping validated; E2E 10/10 |
| T-067 | Freeze C3-C6 contracts + requirements trace | AG-01/05/06/30/51/41 | Done | C3-C6 v1.0 frozen; requirements-trace v1.0 validated; G2 passed |
| T-068 | Contract deviation fixes: device roles, system roles, client logout revocation | AG-06/30/04 | Done | E2E 11/11 includes device route roles; logout revokes server session |
| T-069 | Release drill script + full local drill pass | AG-51/10 | Done | `scripts/release-drill.sh`; `RELEASE DRILL PASSED` with rollback/rebuild, 137 tests, 106/106 OpenAPI, 11/11 E2E |
| T-070 | DDL generator unique-index regression fix | AG-10 | Done | `(org_id, config_key)` index and verify check added to generator; `scheduler_config_org_key=1` |
| T-071 | RC1 release bundle + checksums + Dockerfile lint | AG-51 | Done | `release/ewoh-0.6.0-rc1` 566 files; SHA256SUMS OK; Dockerfile lint 0 issues |
| T-072 | GitHub Actions full CI green | AG-51/41 | Done | `codex/rc1-ci-full` 7474121: standalone/test/security all success, Docker build included |
| T-073 | Bandit/ruff Python cleanup | AG-06/41 | Done | bandit `-ll` 0 medium/high; ruff 0 errors |
| T-074 | Backend deepening: org hierarchy, scheduler weights, control/resource audit, rule dedup | AG-14/16/17/18/19 | Done | 40 suites / 155 tests; E2E 11/11 |
| T-075 | Frontend UX deepening: React Query centers, scheduling/data assets actions, L3/L4 filter, responsive | AG-30/31/32/33/34/35 | Done | 14 client tests; typecheck/build pass |
| T-076 | Second/third/fourth-wave CI re-verification | AG-51/41 | Done | `ad3dc10`, `bb4cd1f`, `148d989` all standalone/test/security success |
| T-077 | Third wave: device/event audit coverage | AG-06/12/18 | Done | Jest 41/156; E2E 11/11; build pass |
| T-078 | Resource inventory persistence via ewoh_resource_binding | AG-17 | Done | inventory row + conditional quantity update; Jest 41/158; E2E 11/11 |
| T-079 | Scheduler plan generation idempotency | AG-16 | Done | `idempotencyKey` deterministic plan IDs; existing plans returned; Jest 41/159 |
| T-080 | Fifth-wave CI verification | AG-51/41 | Done | `d9f7c99` standalone/test/security success |
| T-081 | Security response headers | AG-06/11 | Done | standalone-main headers + unit test; CI `604d831` all green |
| T-082 | Accessibility/UX seventh wave | AG-30/31/44 | Validation | skip link, labels, focus, aria-live, contrast; client 19 tests; CI 3906132 pending |
| T-083 | E2E scheduler idempotency case | AG-16/41 | Done | duplicate-key reuse verified; E2E 12/12 |
| T-084 | Environment mode real data | AG-14/30/31 | Done | `/api/dashboard/environment/summary`; live HTTP smoke; OpenAPI 107/107 |

## Wave RC2 - Ingestion Protocol Alignment (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-085 | Canonical UnifiedExoFrame ingestion + M2M org context | AG-11/14/50 | Done | `round6-ingestion-protocol.md`; 44 Jest suites / 176 tests; E2E 14/14; pytest 59 |

## Wave RC2 - Operations Readiness (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-086 | PostgreSQL logical backup/restore drill + ops runbooks | AG-51/10 | Done | `round7-ops-readiness.md`; `standalone-ops-check.sh` PASSED; perf smoke 4943 qps |

## Wave RC2 - Org Scope Hardening (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-087 | SECURITY DEFINER org lookup + security probe fixture isolation | AG-06/11 | Done | `round8-org-scope-hardening.md`; release drill PASSED; browser login no fallback |

## Wave RC2 - Training Materials (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-088 | Training plan executable v1.1 | AG-52 | Done | `docs/delivery/training-plan.md`; session model, hands-on exercises, verification |

## Wave RC2 - Observability and Deploy Artifacts (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-089 | Prometheus metrics endpoint + business-path perf smoke | AG-11/46 | Done | `round9-observability-deploy-artifacts.md`; `/metrics` 200; overview 514 qps |
| T-090 | Local deploy artifact verifier | AG-51 | Done | `scripts/verify-deploy-artifacts.js`; 62 checks / 0 failures |

## Wave Final4 - MES P0 (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-091 | Final 4.0 baseline adoption | AG-00 | Done | `authoritative-plan-final4.txt`; D-011/D-012/D-013 |
| T-092 | MES P0 production execution closed loop | AG-11/13/20 | Done | `round10-mes-p0.md`; E2E 15/15; OpenAPI 116/116 |

## Wave Final4 - OEE/Andon (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-093 | OEE/Andon closed loop | AG-12/14/22 | Done | `round11-oee-andon.md`; E2E 16/16; OpenAPI 123/123 |

## Wave Final4 - ERP Connector (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-094 | ERP connector skeleton | AG-18/03/11 | Done | `round12-erp-connector.md`; E2E 17/17; OpenAPI 129/129 |

## Wave Final4 - Trace/Mobile (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-095 | Quality trace graph + mobile workbench API | AG-11/13/21 | Done | `round13-trace-mobile.md`; E2E 17/17; OpenAPI 134/134 |

## Next Waves

- W1: DDL/migrations, shared backend, frontend shell, test harness, CI.
- W2: organization, devices, spatial, models, data governance domains.
- W3: task/resource, alert/approval, control, event/notification, pages.
- W4: AI, real reconstruction, gateway, external integrations.
- W5: scenario packages, RLS, concurrency, performance, security, rollback.
- W6: pilot release, monitoring, training, handover.
