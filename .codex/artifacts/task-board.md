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

## Wave Final4 - Mobile UI (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-096 | Mobile workbench React page | AG-30/31 | Done | `round14-mobile-workbench-ui.md`; client tests 20/20; release drill passed |

## Wave Final5 - Scale Kernel (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-097 | Final 5.0 baseline adoption | AG-00 | Done | `authoritative-plan-final5.txt`; D-014/D-015 |
| T-098 | Factory template/profile/asset scale kernel | PX-03 | Done | `round15-final5-scale-kernel.md`; E2E 18/18; managed tables 51 |

## Wave Final5 - Connector/Scenario Catalog (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-099 | Connector + scenario pack catalog and second-factory drill | PX-04/07 | Done | `round16-connector-scenario.md`; OpenAPI 147/147; E2E 18/18 |

## Wave Final5 - Conformance/Replay (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-100 | Asset conformance TCK + factory profile replay | PX-11/09 | Done | `round17-conformance-replay.md`; OpenAPI 149/149; E2E 18/18 |

## Wave Final5 - Fleet Ops + Event Catalog (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-101 | Scenario install TCK gate + fleet upgrade/rollback | PX-09/07 | Done | `round18-fleet-ops-event-catalog.md`; Jest 54/224; E2E 19/19; OpenAPI 154/154 |
| T-102 | AsyncAPI/CloudEvents event catalog + API + audit | PX-10/11 | Done | `contracts/events/event-catalog.yaml`; `GET /api/events/catalog`; contract audit 13/13 |

## Wave Final5 - Deployment Factory (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-103 | Helm chart + Factory Values + static chart audit | PX-09/51 | Done | `round19-helm-deployment-factory.md`; chart audit 123 checks; Jest 4/4 |

## Wave Final5 - Golden Factory (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-104 | Golden Factory Profile manifest + install API | PX-07/09 | Done | `round20-golden-factory.md`; audit 47 checks; E2E golden install/reuse passed |

## Wave Final5 - Mapping DSL (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-105 | Mapping DSL schema + example + registry API + TCK | PX-05/04 | Done | `round21-mapping-dsl.md`; audit 10 checks; E2E mapping register/conformance passed |

## Wave Final5 - Fleet Ops Rings (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-106 | Upgrade rings + fleet registry + redacted support bundle | PX-09/10 | Done | `round22-fleet-rings-support.md`; E2E ring staging/status/support bundle passed |

## Wave Final5 - Observability (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-107 | OTel resource attributes across metrics and deployment env | PX-10/51 | Done | `round23-otel-resource-attributes.md`; E2E /metrics 20/20; verifier 66/66 |

## Wave Final5 - Compatibility Catalog (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-108 | Asset/core compatibility catalog API + range matcher | PX-11/04 | Done | `round24-compatibility-catalog.md`; E2E incompatible legacy connector verified |

## Wave Final5 - Policy Engine (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-109 | Policy schema + evaluation API + contract audit | PX-06/20 | Done | `round25-policy-engine.md`; E2E risky deny/safe allow passed |

## Wave Final5 - Config Inheritance (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-110 | Template config inheritance diff preview API | PX-03/05 | Done | `round26-diff-preview.md`; E2E preview passed |

## Wave Final5 - Connector Runtime (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-111 | Connector runtime + exoskeleton/equipment-state manifests | PX-04/13 | Done | `round27-connector-runtime.md`; pytest 69 passed |

## Wave Final5 - Factory Onboarding (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-112 | F0-F6 factory onboarding checklist + run API | PX-12/07 | Done | `round28-factory-onboarding.md`; E2E onboarding passed |

## Wave Final5 - Scale Release (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-113 | Scale Release review gate + package hook | PX-09/51 | Done | `round29-scale-release-review.md`; review 24/24 passed |

## Wave Final5 - Workflow Engine (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-114 | Workflow schema + role-aware advance API + audit | PX-06/16 | Done | `round30-workflow-engine.md`; E2E role gating passed |

## Wave Final5 - Feature Flags (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-115 | Org-scoped feature flag API on system config store | PX-06/21 | Done | `round31-feature-flags.md`; E2E org isolation passed |

## Wave Final5 - Edge Resilience (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-116 | Sequence buffer for out-of-order/duplicate/backfill | V-CON/13 | Done | `round32-edge-backfill.md`; pytest 74 passed |

## Wave Final5 - Twin Package (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-117 | Twin package manifest/calibration pipeline + samples | PX-08/14 | Done | `round33-twin-package.md`; pytest 81 passed |

## Wave Final5 - Partner Shadow (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-118 | Partner shadow checklist + shadow-run API | PX-13/12 | Done | `round34-partner-shadow.md`; E2E partner run passed |

## Wave Final5 - Deployment TCK (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-119 | Deployment TCK gate across deploy/Helm/release checks | PX-09/51 | Done | `round35-deployment-tck.md`; 3 gates passed |

## Wave Final5 - Scale UI (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-120 | Scale operations page wired to real scale APIs | AG-30/31 | Done | `round36-scale-ui.md`; client Jest 6/21; build passed |

## Wave Final5 - Connector Profile (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-121 | ERP/MES connector profile manifest + runtime tests | PX-04/18 | Done | `round37-erp-mes-connector.md`; pytest 82 passed |

## Wave Final5 - Scale Metrics (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-122 | Scale productization metrics API | PX-13/10 | Done | `round38-scale-metrics.md`; E2E metrics passed |

## Wave Final5 - Scenario Lifecycle (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-123 | Scenario pack uninstall API + audit | PX-07/18 | Done | `round39-scenario-uninstall.md`; E2E uninstall passed |

## Wave Final5 - Connector TCK (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-124 | Connector TCK runner + make entry | V-CON/11 | Done | `round40-connector-tck.md`; 11 checks passed |

## Wave Final5 - Scenario TCK (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-125 | Scenario TCK runner across golden/policy/workflow/mapping/events | PX-11/07 | Done | `round41-scenario-tck.md`; 5 gates passed |

## Wave Final5 - Third Factory (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-126 | Third factory config-driven install drill | PX-12/04 | Done | `round42-third-factory-drill.md`; E2E config install passed |

## Wave Final5 - Difference Recycling (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-127 | Factory difference register/list API + audit | PX-05/12 | Done | `round43-factory-differences.md`; E2E difference registry passed |

## Wave Final5 - Difference Resolve (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-128 | Factory difference resolve API + audit | PX-05/12 | Done | `round44-difference-resolve.md`; E2E resolve passed |

## Wave Final5 - Cross-Tenant TCK (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-129 | Cross-tenant full-chain TCK gate | V-SEC/41 | Done | `round45-cross-tenant-tck.md`; E2E 23/23 passed |

## Wave Final5 - Differences UI (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-130 | Factory differences register/resolve UI on /scale | AG-30/31 | Done | `round46-differences-ui.md`; client build passed |

## Wave Final5 - Workflow Instances (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-131 | Stateful workflow instance start/list/advance API | PX-06/16 | Done | `round47-workflow-instances.md`; E2E lifecycle passed |

## Wave Final5 - Support Bundle UI (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-132 | One-click support bundle generation UI on /scale | AG-30/31 | Done | `round48-support-bundle-ui.md`; client build passed |

## Wave Final5 - Fleet UI (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-133 | Fleet status + ring upgrade/rollback UI on /scale | AG-30/31 | Done | `round49-fleet-ui.md`; client build passed |

## Wave Final5 - Workflow UI (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-134 | Workflow instance start/list/advance UI on /scale | AG-30/31 | Done | `round50-workflow-instances-ui.md`; client build passed |

## Wave Final5 - Scenario UI (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-135 | Scenario pack install/uninstall UI on /scale | AG-30/31 | Done | `round51-scenario-ui.md`; client build passed |

## Wave Final5 - Operations Capability (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-136 | EAM/tooling + work-center config + standard hours/efficiency | PX-14/15 | Done | `round52-operations-capability.md`; Jest 65/291; client 6/22; OpenAPI 198/198; E2E 24/24; standalone check PASSED |

## Wave Final5 - Standard Protocol & Flag SDK (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-137 | Sparkplug B connector + OpenFeature flag evaluation | V-CON/06 | Done | `round53-sparkplug-openfeature.md`; pytest 89; Jest 65/292; client 6/22; OpenAPI 199/199; E2E 25/25; connector TCK 17/17 |

## Wave Final5 - Parameter Registry (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-138 | Typed parameter registry with approval/version/rollback | PX-06/21 | Done | `round54-parameter-registry.md`; Jest 66/298; client 6/22; OpenAPI 207/207; E2E 26/26 |

## Wave Final5 - AAS Asset Exchange (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-139 | AAS/IEC 63278 JSON + AASX codec and twin submodel mapping | PX-08/14 | Done | `round55-aas-codec.md`; pytest 99; AAS TCK 7/7 |

## Wave Final5 - OPA Policy-as-Code (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-140 | Rego policy-as-code deployment gate + deployment TCK integration | PX-06/51 | Done | `round56-rego-policy-as-code.md`; pytest 107; rego TCK 4/4; deployment TCK 4 gates |

## Wave Final5 - AAS Asset Registry API (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-141 | AAS asset registry API + twin semantics + Data Assets UI | PX-08/21 | Done | `round57-aas-asset-api.md`; Jest 67/302; client 6/22; OpenAPI 211/211; E2E 27/27 |

## Wave Final5 - OPC UA Connector (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-142 | OPC UA node ID/quality/adapter + connector manifest | V-CON/05 | Done | `round58-opcua-connector.md`; pytest 111; connector TCK 21/21 |

## Wave Final5 - Modbus TCP Connector (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-143 | Modbus TCP register/scaling/adapter + connector manifest | V-CON/05 | Done | `round59-modbus-connector.md`; pytest 114; connector TCK 25/25 |

## Wave Final5 - HTTP/Webhook Connector (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-144 | HTTP/Webhook payload/signature/adapter + connector manifest | V-CON/05 | Done | `round60-webhook-connector.md`; pytest 117; connector TCK 29/29 |

## Wave Final5 - CSV/File Connector (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-145 | CSV/File header mapping/row normalization/adapter + connector manifest | V-CON/05 | Done | `round61-csv-file-connector.md`; pytest 120; connector TCK 32/32 |

## Wave Final5 - Observability Traces (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-146 | OTel-style request tracing interceptor/service/API | PX-10/46 | Done | `round62-otel-request-tracing.md`; Jest 69/306; OpenAPI 212/212; E2E 28/28 |

## Wave Final5 - Support Bundle Trace Inclusion (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-147 | Support bundle includes redacted recent traces | PX-10/09 | Done | `round63-support-bundle-traces.md`; E2E 28/28 |

## Wave Final5 - Tracing UI (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-148 | System page request tracing viewer | AG-34/35 | Done | `round64-tracing-ui.md`; client 6/22; build passed |

## Wave Final5 - RC2 Release Bundle (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-149 | Regenerate RC2 release bundle with all new capabilities | AG-51 | Done | `round65-release-bundle-rerolled.md`; 1315 files; review 24/24 |

## Wave Final5 - Final Gate Sweep (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-150 | Final one-click gate sweep (ops/scenario/deploy/AAS/Rego/connector/cross-tenant) | AG-00/51 | Done | `round66-final-gate-sweep.md`; all gates passed |

## Wave Final5 - Pilot Readiness Gate (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-151 | Pilot readiness Go/No-Go blocker gate | AG-51/00 | Done | `round67-pilot-readiness-blockers.md`; blockers documented |

## Wave Final5 - Release Bundle Re-roll with Pilot Gate (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-152 | Rebuild RC2 bundle with pilot readiness gate | AG-51 | Done | `round68-release-bundle-includes-pilot-gate.md`; 1316 files; review 24/24 |

## Wave Final6 - Work Orchestration Control Plane (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-153 | Final 6.0 baseline adoption and authoritative plan extraction | AG-00 | Done | `authoritative-plan-final6.txt`; D-033 |
| T-154 | C7 Work Graph / C8 Asset Catalog / C9 Factory Profile contracts + audits | ORCH-01/PX-03 | Done | `contracts/work/`, `contracts/catalog/`, `contracts/factory/`, 17+32+8 audit checks |
| T-155 | Work Graph indexer, gate engine, resource registry, handoff CLI | ORCH-02/03/04/06 | Done | `tools/work-indexer/`, `tools/gate-engine/`, `tools/resource-registry/`, `tools/handoff-service/` |
| T-156 | Work orchestration NestJS APIs + OpenAPI | ORCH-01/11 | Done | `server/modules/work-orchestration/`, `openapi/work-orchestration.yaml`, 226/226 route audit |
| T-157 | Work orchestration control plane UI | ORCH-05/30 | Done | `client/src/pages/WorkOrchestration/`, Playwright render, no console errors |
| T-158 | Final 6 scenario packs, ERP connectors and mappings | PROD-31/32/33/INT-31 | Done | `catalog/` 8 assets; asset catalog audit 32 checks |
| T-159 | Final 6 verification sweep and evidence | ORCH-01/VAL-61 | Done | `round69-final6-work-orchestration.md`; standalone check, E2E 29/29, release review 32/32 |
| T-160 | Offline-first GitHub Issue/PR sync plan and API | ORCH-01 | Done | `tools/git-sync/`, `GET /api/work/git-sync`, Git Sync UI; live apply approval-gated |
| T-161 | Fresh PostgreSQL 17 DDL/RLS/audit/rollback/rebuild gate | AG-10/41 | Done | `standalone-postgres-check.sh` PASSED; 51 tables, RLS, audit chain, 0 objects after rollback |
| T-162 | Environment probe refresh and local gate sweep | AG-10/50/51 | Done | `inventory/environment.md`; scenario/connector/AAS/Rego/deploy/cross-tenant all passed |
| T-163 | Factory replication acceptance TCK | PX-03/07/VAL-62 | Done | `tools/factory-replication/`, `replication-report.schema.json`, passing/failing fixtures |
| T-164 | Perf, ops backup/restore, and pilot readiness evidence | AG-46/51 | Done | perf 1368 QPS; ops 57 tables; pilot readiness NOT READY with documented external blockers |
| T-165 | Client Jest runner and audit chain stress coverage | AG-30/06 | Done | `client/jest.config.cjs`, `npm run test:client` 7/25; audit chain 100 entries |
| T-166 | EWOH 0.6.0-rc3 release bundle | AG-51 | Done | `release/ewoh-0.6.0-rc3` 1537 files; SHA256SUMS; review 34/34 |
| T-167 | Factory site-readiness evaluator and fixtures | PX-03/07 | Done | `site-readiness.js`, `site-readiness.schema.json`, ready/not-ready fixtures; audit 20 checks |
| T-168 | Final release drill and Python/security evidence | AG-51/10 | Done | `RELEASE DRILL PASSED`; unittest 667, pytest 120, ruff clean |
| T-169 | Work console UX deepening and API filters | ORCH-05/01 | Done | DAG pan/zoom, node search, gate/evidence filters, evidence preview, batch gate decisions, lock countdown, `q/limit/offset`; Jest 74/331, client 7/27 |
| T-170 | Factory site readiness control-plane API/UI | ORCH-01/05 | Done | `GET /api/work/site-readiness`, catalog examples, 场地就绪 tab; audit 25 checks; OpenAPI 230/230 |
| T-171 | Handoff state workflow | ORCH-06/01 | Done | `POST /api/work/handoffs/:id/state`; receive/reject/close UI; Jest 74/332; OpenAPI 231/231 |

## Wave Iteration 2026-08-04 - P0 Hardening (in progress)

| ID | Task | Owner | Status | Evidence |
|----|------|-------|--------|----------|
| T-172 | Repo facts consistency audit + CI wiring | AG-00/01 | Done | `scripts/audit-repo-facts.js` 30/30; wired into `standalone-check.sh` and `test.yml` |
| T-173 | Unified error contract: errorCode/requestId/retryable/recommendedAction/details | AG-00/03 | Done | `exception.filter.ts` + `api_response.interface.ts` + OpenAPI `ErrorResponse`; 8 filter tests; Jest 75/344 |
| T-174 | Data source vocabulary + reusable badge | AG-00/05 | Done | `DataSourceType` six values; `DataSourceBadge`; Devices uses shared component; client 8/30 |
| T-175 | Nested request transaction reuse for scheduler/background GUC | AG-00/04 | Done | `RequestDatabaseContext` active-store reuse; unit test; no nested root transaction |
| T-176 | Mobile SOP/exception/QC/offline UX | AG-00/07 | Done | MES pause/resume resultJson; mobile quality API; MobileWorkbench SOP/异常/质检/离线/重试; MES+mobile unit tests |
| T-177 | Independent review and first-round evidence | AG-13/00 | Done | conditional pass 0 critical/0 major; `work/reviews/iteration-review-2026-08-04.md`; `round70-iteration-p0-2026-08-04.md` |
| T-178 | Global ValidationPipe with structured fieldErrors | AG-00/03 | Done | `server/common/pipes/validation.pipe.ts`; APP_PIPE in both bootstraps; 5 validation-pipe tests; Jest 76/349 |
| T-179 | Command-map person/device detail enrichment | AG-00/06 | Done | `entityDetailData.ts` + tests; organization/exoskeleton/risk/alerts/events/disposition entry; client 9/33 |
| T-180 | Mobile offline pending-action queue | AG-00/07 | Done | `lib/offlineQueue.ts` + tests; queue/flush on reconnect; client 10/35 |
| T-181 | Control/work orchestration state guards | AG-00/03/04 | Done | control terminal/in-flight guards; handoff state machine; gate decision idempotency + history; Jest 76/355 |
| T-182 | Scale mutation idempotency guards | AG-00/09 | Done | scenario install/uninstall idempotent; fleet upgrade/rollback skip target state; difference resolve idempotent; Jest 76/359 |
| T-183 | Real PostgreSQL HTTP E2E acceptance | AG-13/41 | Done | `npm run test:e2e` 29/29 on embedded PG 17 (`127.0.0.1:55432`) |
| T-184 | Mobile exception photo attachments | AG-00/07 | Done | `/api/files` upload + `resultJson.exception.attachments`; client 11/37 |
| T-185 | PWA installability assets | AG-00/07 | Done | manifest + service worker + registration; repo facts 32/32 |
| T-186 | Offline photo queue | AG-00/07 | Done | data URL queue + flush upload/attach; client 12/39 |
| T-187 | Release drill + perf + security verification | AG-13/51 | Done | `RELEASE DRILL PASSED`; perf 4610 QPS p95 26.83ms; security probe OK; bandit 0 medium/high |
| T-188 | Playwright browser screenshots | AG-13/30 | Done | mobile + desktop `/login` screenshots in `output/playwright/` |
| T-189 | Request ID audit correlation | AG-00/11 | Done | AsyncLocalStorage request context; audit entries auto-filled; repo facts 33/33 |
| T-190 | Error leak sanitization | AG-00/12 | Done | HttpException details sanitized; site readiness generic error; Jest 76/362 |
| T-191 | Devices page error/update state | AG-00/05 | Done | isError + retry + updatedAt display in device list |
| T-192 | Command map query error banner | AG-00/06 | Done | failed query banner + retry; client 13/42 |
| T-193 | EWOH 0.6.0-rc4 candidate bundle | AG-51 | Done | `release/ewoh-0.6.0-rc4` 1201 files; SHA256SUMS; scale-release-review PASSED |
| T-194 | Authenticated Playwright browser tests | AG-13/30 | Done | dispatcher login + command center/map/mobile workbench on real PG fixture; `npm run test:browser` 3/3 |
| T-195 | Browser tests in CI | AG-51/13 | Done | `standalone.yml` installs Chromium and runs `npm run test:browser` |
| T-196 | Pilot readiness rerun (RC4) | AG-51/00 | Done | 7 passed / 3 failed (Docker/Kubectl/Helm absent) / 5 pending external; NOT READY |

## Next Waves

- W1: DDL/migrations, shared backend, frontend shell, test harness, CI.
- W2: organization, devices, spatial, models, data governance domains.
- W3: task/resource, alert/approval, control, event/notification, pages.
- W4: AI, real reconstruction, gateway, external integrations.
- W5: scenario packages, RLS, concurrency, performance, security, rollback.
- W6: pilot release, monitoring, training, handover.
- W6-Final6: work graph writes, GitHub Issue/PR sync, factory replication drills, partner delivery.
