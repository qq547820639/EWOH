# EWOH Phase State

Updated: 2026-08-04
Trace: EWOH-2026-08-04-principal-final6

## Latest Round - 2026-08-04 P0 Hardening

- Repo facts gate `scripts/audit-repo-facts.js` added and wired into
  `standalone-check.sh` / `test.yml`: README navigation, CHANGELOG vs release
  manifest, Task Board evidence, G0-G13 coverage, phase trace, route manifest
  freshness, data-source vocabulary, and error contract all pass (30/30).
- Unified error envelope now carries `errorCode` (with `code` as legacy alias),
  `message`, `fieldErrors`, `requestId`, `retryable`, `recommendedAction`,
  `details`, and correlates `requestId` with Tracing `x-trace-id`.
- Data-source vocabulary extended to `real / controlled_test / simulated /
  replayed / stale / offline`; OpenAPI enums synced; reusable `DataSourceBadge`
  wired into the Devices page.
- `RequestDatabaseContext` reuses an active request transaction for nested
  `runInTransaction` calls, eliminating the scheduler's nested root transaction.
- Mobile workbench now shows SOP instruction text, supports pause/resume,
  exception reporting (`resultJson.exception`), quality inspection via
  `POST /api/mobile/workbench/orders/:orderId/steps/:stepId/quality`, offline
  indication, and inline retry after a failed action.
- Global `ValidationPipe` registered in Legacy and Standalone bootstraps;
  `class-validator` errors now map to `fieldErrors` and `VALIDATION_ERROR`.
- Command-map entity details now resolve personnel/device archives with
  organization, exoskeleton, risk, alerts, recent events, and disposition entry.
- Mobile workbench now queues offline actions in `localStorage` and flushes them
  in order when connectivity returns; pending count is shown in the header.
- Mobile exception reports support photo attachments uploaded through
  `/api/files`; the file reference is stored in `resultJson.exception.attachments`.
- Standalone client now ships a PWA manifest, service worker, and registration
  so the app can be installed on phones and industrial tablets.
- Offline exception photos are queued as data URLs and uploaded/attached
  automatically when connectivity returns.
- Control commands now reject terminal-state sends/receipts and duplicate
  in-flight sends; work orchestration handoffs use a strict state machine and
  gate decisions preserve history with idempotent repeats.
- Scale mutations are idempotent for repeated scenario install/uninstall,
  fleet upgrade/rollback to the same target state, and already-resolved
  factory differences.
- Full standalone gate: typecheck, lint, Jest 76 suites / 359 tests, client
  12 suites / 39 tests, repo facts 32/32, OpenAPI 232/232, production build, and
  DDL hygiene all PASSED. Independent review: conditional pass with 0 critical
  and 0 major findings. HTTP+PostgreSQL E2E passed locally on embedded PG 17:
  `29/29` across SP-01..SP-08 and work orchestration acceptance.
- `RELEASE DRILL PASSED` on embedded PG 17 (apply/verify/RLS/audit/rollback/
  rebuild + standalone gate + E2E); perf smoke `/health/live` 500 req /
  50 concurrency = 4610 QPS, p95 26.83ms, 0 failures; standalone security probe
  `STANDALONE SECURITY VERIFY OK`; `python3 -m bandit -r src/edge_platform -ll`
  reports 0 medium/high issues.
- Playwright browser evidence captured for Standalone `/login` at mobile
  (390x844) and desktop (1440x900) viewports in `output/playwright/`.
- Request tracing and audit are correlated: `requestId` flows through
  AsyncLocalStorage from the tracing interceptor into audit entries.
- HttpException details are sanitized and site-readiness parse failures return
  generic errors instead of raw exception text.
- Devices page distinguishes loading, error (with retry), and empty states and
  shows the last successful data update time.
- Command map shows a retryable banner when entity/world/overview/environment
  queries fail instead of rendering silently empty placeholders.
- `EWOH 0.6.0-rc4` candidate bundle generated: 1202 files, SHA256SUMS,
  `scale-release-review` PASSED.
- Authenticated Playwright tests pass 4/4: dispatcher login plus command
  center, command map, mobile workbench, and alerts renders against a real
  PostgreSQL fixture (`npm run test:browser`).
- CI runs the Playwright browser suite: `standalone.yml` installs Chromium and
  executes `npm run test:browser` after HTTP+PostgreSQL E2E.
- Pilot readiness rerun: 7 passed (rc4 bundle, evidence, training, runbook,
  manifest, DB verify, runtime connect), 3 failed (Docker/Kubectl/Helm absent
  locally), 5 pending external approval/signoff; result NOT READY.
- Standalone ops drill passed on rc4: 57-table logical backup/restore/verify
  and post-restore identity sequence check (`ALL STANDALONE OPS CHECKS PASSED`).
- Full standalone gate: typecheck, lint, Jest 76 suites / 362 tests, client
  13 suites / 42 tests, repo facts 33/33, OpenAPI 232/232, production build, and

## Latest Round - 2026-08-04 P0 Mobile/Orchestration

- Mobile workbench P0 closed: person/org filtering with fail-closed, typed
  scan recognition, exception attachment persistence, offline queue states,
  per-item retry, and `worker` role access.
- Work Graph evidence binding closed: front matter parsing, derived
  commit/env/dependency/build metadata, `valid/stale/expired/unbound`
  invalidation, and `--invariants` graph checks.
- `tools/work-console` added and wired into `standalone-check.sh` and CI:
  blockers, missing evidence, unblock owners, affected tasks, and gate
  approval summary in one command.
- Task Graph dependency references corrected to real node IDs; 19 orphan
  edges removed; generated outputs refreshed.
- Verification: server Jest 78 suites / 375 tests, client 13 suites / 46
  tests, typecheck/lint/build pass, repo facts 33/33, OpenAPI 232/232,
  work graph contract audit 20/20, invariants 0 conflicts, work-console
  strict pass.
- Independent review closed: worker write-path assignment guard,
  conflict discard, CI strict indexer, scan body guard, and stronger
  predicate tests.
- Round 91 evidence binds the review fixes to `fac2e6f`; work graph now has
  238 items / 25 edges / 95 evidence with 0 invariant conflicts.

## Latest Round - 2026-08-04 Onboarding/Mapping Real Gate

- Onboarding F0 now validates site readiness evidence before profile work;
  F2 publishes/verifies connectors; F3 installs/verifies scenario packs.
- Mapping dry-run API `POST /api/scale/mappings/:id/dry-run` applies rules to
  a sample payload and returns localized required/transform errors.
- Real PostgreSQL E2E passed 29/29 including the new onboarding and mapping
  paths; authenticated browser flow passed 4/4.
- Full gate with runtime DB: server Jest 78/377, client 13/46, OpenAPI 233/233,
  repo facts 33/33, work graph 241 nodes / 0 invariant conflicts, build passed.

## Latest Round - 2026-08-04 World Replay Unified Timeline

- `GET /api/world/replay` now merges world states, events, tasks, steps, and
  material changes into lane-aware snapshots.
- `GET /api/world/replay/context/:eventId` returns before/during/after
  snapshots around an event.
- `POST /api/world/replay/items` creates an issue/task/evidence from a replay
  event and writes a `derived_from_replay` causal chain with audit.
- TimelinePanel displays lane labels and a one-click “跟进” action.
- Real PostgreSQL E2E: 30/30 passed including the new replay scenario.
- Full suite after replay wave: server Jest 79/380, client 13/46, OpenAPI
  235/235, work graph 242 nodes / 99 evidence / 0 invariant conflicts.

## Latest Round - 2026-08-04 E-SOP Sign-off

- SOP assets registered/published/diffed under `/api/mes/sops` using existing
  `ewoh_asset_package` storage.
- Work order steps can bind SOP version, mandatory flag, required tools and
  materials; start/report enforce sign-off and confirmations.
- Signatures are persisted in `resultJson.sop.signatures` with actor/tools/
  materials timestamp.
- Real PostgreSQL E2E: 31/31 passed including SOP register/publish/diff and
  sign-off gating.
- Full suite after E-SOP wave: server Jest 79/383, client 13/46, OpenAPI
  240/240, work graph 243 nodes / 100 evidence / 0 invariant conflicts.

## Latest Round - 2026-08-04 Quality Schemes

- Quality schemes registered/published/matched under `/api/mes/quality-schemes`
  with `first/in_process/final` stages and required check items.
- `qualityInspection` accepts `schemeId/stage/checkResults`, rejects missing
  required checks and inconsistent pass results, and persists scheme results.
- Real PostgreSQL E2E: 32/32 passed including scheme match and enforcement.
- Full suite after quality wave: server Jest 79/386, client 13/46, OpenAPI
  245/245, work graph 244 nodes / 101 evidence / 0 invariant conflicts.

## Latest Round - 2026-08-04 Slow Query Observability

- `RequestDatabaseContext` applies `EWOH_DB_STATEMENT_TIMEOUT_MS` and records
  transactions over `EWOH_DB_SLOW_THRESHOLD_MS`.
- `GET /api/observability/slow-queries` returns bounded slow transaction
  records with requestId; `/metrics` exposes `ewoh_slow_queries_total`.
- Real PostgreSQL E2E: 32/32 passed including slow-query API and metric.
- Full suite after observability wave: server Jest 80/388, client 13/46,
  OpenAPI 246/246, work graph 245 nodes / 102 evidence / 0 invariant conflicts.

## Latest Round - 2026-08-04 Frontend Performance

- Client page routes now use `React.lazy` with a shared Suspense fallback;
  standalone build splits per-page chunks and the main bundle drops from
  ~2.3MB to ~374KB.
- World state and replay requests accept `AbortSignal` through React Query,
  enabling cancellation on unmount/refetch.
- Authenticated browser flows still pass 4/4.
- Full suite remains server 80/388, client 13/46, OpenAPI 246/246; work graph
  246 items / 103 evidence / 0 invariant conflicts.

## Latest Round - 2026-08-04 MES Role Workbench

- `GET /api/operations/role-workbench` aggregates operator/team lead/quality/
  equipment/manager views from production tables.
- New `/role-workbench` page with role tabs, summary cards, and table views.
- Real PostgreSQL E2E: 33/33; authenticated browser: 5/5.
- Full suite after role workbench wave: server Jest 81/391, client 13/46,
  OpenAPI 247/247, work graph 247 items / 104 evidence / 0 conflicts.

## Latest Round - 2026-08-04 Progressive Lists

- `progressiveSlice/hasMoreItems/nextProgressiveLimit` helper added with unit
  tests.
- Role workbench list tables render 50 rows at a time with a “加载更多”
  button.
- Client suite: 14 suites / 48 tests.
- Work graph after progressive list wave: 248 items / 105 evidence /
  0 invariant conflicts.

## Current Phase

Final 6.0 work orchestration wave: C7-C9 contracts, file-backed Work Graph
indexer, gate engine, resource registry, handoff service, NestJS APIs, React
control plane, and Final 6 scenario/connector/mapping catalogs are implemented
and validated. Remaining external blockers are GitHub Issue/PR sync, two real
factory replication drills, partner shadow delivery, and production SLO/approval.

## Just Completed

- Final 6.0 authoritative plan adopted and extracted to
  `authoritative-plan-final6.txt`; D-033 recorded.
- C7 Work Graph, C8 Asset Catalog, C9 Factory Profile schemas and audits
  added; work graph/asset catalog/factory profile audits pass.
- `tools/work-indexer`, `tools/gate-engine`, `tools/resource-registry`, and
  `tools/handoff-service` implemented with strict CLI checks.
- Work orchestration APIs under `/api/work/*` implemented, documented in
  `openapi/work-orchestration.yaml`, and included in the 226-operation route
  audit.
- React `/work-orchestration` control plane renders the DAG, gates, evidence,
  agents, risks, resources, handoffs, and asset catalog from real APIs.
- Order-to-Delivery, mobile E-SOP, quality trace, and inventory collaboration
  scenario manifests plus ERP order/inventory connector and mapping manifests
  added to `catalog/`.
- Local PostgreSQL HTTP smoke verified `/api/work/*` on `:3102`; write APIs
  return 400 when `EWOH_WORK_WRITABLE` is disabled.
- Environment inventory refreshed; local gate sweep passed (scenario,
  connector, AAS, Rego, deployment, cross-tenant), perf smoke 1368 QPS, and
  ops backup/restore of 57 tables.
- Factory replication acceptance TCK added with no-core-fork/config-rate/
  difference-resolution gates and passing/failing fixtures.
- Client Jest gate added (`npm run test:client`, 7 suites / 25 tests) and
  `release/ewoh-0.6.0-rc3` bundle built with 1532 files and checksums.
- Factory site-readiness evaluator and fixtures added; final `release-drill.sh`
  passed with 74 Jest suites / 327 tests, Python 667+120, and 34/34 release
  review.
- Three independent reviews (security, persistence/tenancy, frontend/scenario)
  and WP-HARDEN-001 fixes across RBAC, refresh rotation/logout, rate limiting,
  system config unique index, simulator GUC context, conditional state
  transitions, audit wiring, domain persistence, and frontend command map.
- Full Jest regression: 39 suites / 122 tests; E2E HTTP+PostgreSQL: 9/9.
- PostgreSQL standalone apply/verify (48/48) and security probe pass.
- Route audit: 106 controller operations, 0 unimplemented.
- Ingestion protocol aligned to `UnifiedExoFrame.to_storage_dict()` canonical
  shape; `X-Org-Id` M2M tenant context; `assist_level real`; 44 Jest suites /
  176 tests; HTTP+PostgreSQL E2E 14/14; pytest 59.
- Ops readiness: logical backup/restore of 54 tables PASSED, post-restore
  identity smoke PASSED, perf smoke 4943 qps / p95 17.50ms, operations and
  deployment runbooks completed.
- Org scope hardening: `ewoh_find_org` / `ewoh_find_org_children`
  `SECURITY DEFINER` lookup PASSED; security probe fixtures randomized;
  browser login resolves scope without fallback warnings.
- Observability: `GET /metrics` Prometheus output verified; business-path
  perf 514 qps / p95 60.93ms; deploy artifact verifier 62/62.
- Final 4.0 adopted as master baseline; MES P0 work order/step/material/
  inspection closed loop is implemented and verified end to end.
- OEE/andon closed loop: device status timeline, OEE calculation, andon state
  machine, and SLA escalation notification are implemented and verified.
- ERP connector: idempotent inbound orders, outbound queue with ack, and
  reconciliation summary are implemented and verified.
- Quality trace graph and mobile workbench API are implemented and verified.
- Mobile workbench React page is implemented and verified with client tests.
- Final 5.0 adopted; scale kernel (factory template/profile/asset registry) is
  implemented and verified with 51 managed tables.
- Connector and scenario pack catalog are implemented and verified; a
  published template installs multiple factory profiles without a code fork.
- Asset conformance TCK and factory profile replay are implemented and
  verified.
- Scenario pack install now requires a passing scenario TCK; fleet
  upgrade/rollback endpoints update all org-visible profiles and are audited.
- AsyncAPI 2.6 + CloudEvents 1.0 event catalog with 13 event types is
  implemented as a contract, an audited API, and a CI-validated artifact.
- Full Jest regression: 56 suites / 232 tests; HTTP+PostgreSQL E2E 19/19;
  OpenAPI strict audit 155/155; standalone production build passed.
- Helm chart deployment factory: `deploy/cloud/helm/ewoh` with Factory
  Values, migration Job hook, HA templates, and a 123-check static audit;
  chart contract test added.
- Golden Factory Profile: versioned manifest with 7 modules, 3 connectors and
  4 scenario packs; one-command install API is deterministic, TCK-gated,
  org-scoped and idempotent; contract audit 47 checks.
- Mapping DSL and Schema Registry: versioned JSON Schema with a canonical
  exoskeleton telemetry example, mapping asset API, and mapping TCK checks;
  contract audit 10 checks.
- Upgrade rings and fleet ops: ring-filtered fleet upgrade/rollback, fleet
  status registry, and redacted support bundle are implemented, audited, and
  covered by unit and E2E tests.
- OTel resource attributes: `/metrics` exposes factory id/name/upgrade ring/
  release version/region; the environment contract is wired through standalone
  env, Compose, Kubernetes, and Helm.
- Compatibility catalog: `GET /api/scale/compatibility` returns the asset/core
  matrix with semver-like range matching; E2E verifies an incompatible legacy
  connector is flagged.
- Policy engine: `contracts/policy/policy-schema.json` plus
  `POST /api/policies/evaluate` provide schema-validated rule evaluation;
  canonical operator-safety policy is served and exercised in E2E.
- Template config diff preview: `POST /api/scale/templates/:id/diff-preview`
  returns inherited/merged config and added/changed/removed keys without
  mutating state.
- Connector runtime: `src/edge_platform/connectors` loads/validates versioned
  manifests, checks health/config, redacts secrets, and manages lifecycle;
  exoskeleton-frame and equipment-state sample manifests are included.
- Factory onboarding: `POST /api/scale/onboarding/run` executes the F0-F6
  single-factory import steps with per-step evidence and audit; checklist API
  exposes the machine-readable steps.
- Scale release review: `scripts/scale-release-review.js` is the packaging
  gate for release bundles, running contract/deploy/ops checks (23/23 pass).
- Workflow engine: versioned workflow contract plus role-aware
  `POST /api/workflows/advance`; canonical MES execution flow is covered by
  contract and E2E tests.
- Feature flags: org-scoped `feature.*` flags persist in `ewoh_system_config`;
  global-admin writes are enforced and cross-org reads are RLS-isolated.
- Edge resilience: `SequenceBuffer` handles out-of-order, duplicate, stale,
  gap, and backfill cases for connector/edge bridge telemetry.
- Twin package pipeline: versioned twin manifests validate model format,
  coordinate system, semantics, calibration readiness, and rollback metadata.
- Partner shadow delivery: partner checklist and shadow-run reuse the real
  F0-F6 onboarding path with `partnerShadow` config and step-level evidence.
- Deployment TCK: `scripts/deployment-tck.js` runs deploy artifact, Helm, and
  release review gates as one deployment acceptance command.
- Scale operations UI: `/scale` page shows templates/profiles/assets/
  compatibility and runs F0-F6 onboarding against real APIs.
- ERP/MES connector profile: versioned manifest with HTTP REST protocol,
  secret-reference config, and runtime test coverage.
- Scale metrics: `GET /api/scale/metrics` exposes template/profile/asset
  counts, published rate, ring distribution, and compatibility summary.
- Scenario lifecycle: `POST /api/scale/scenario-packs/:id/uninstall` removes a
  scenario pack with audit, completing install/demo/accept/remove flow.
- Connector TCK: `scripts/connector-tck.py` and `make connector-tck` run 11
  manifest/config/health/redaction/sequence checks.
- Scenario TCK: `scripts/scenario-tck.js` and `npm run scenario:tck` run five
  scenario-related contract audits as one gate.
- Third factory drill: E2E installs a third factory profile from the same
  published template using config only, with persisted config and org scope.
- Factory differences: `POST/GET /api/scale/differences` registers and lists
  org-scoped factory differences for recycling/platformization.
- Difference resolution: `POST /api/scale/differences/:key/resolve` marks
  recycled differences as resolved with audit.
- Cross-tenant TCK: `scripts/cross-tenant-tck.sh` runs the HTTP+PostgreSQL
  org-isolation E2E suite as one gate.
- Factory differences UI: `/scale` page registers, lists, and resolves
  factory differences through the real API.
- Workflow instances: `POST/GET /api/workflows/instances` and
  `POST .../:key/advance` persist org-scoped workflow state with role gating
  and audit.
- Support bundle UI: `/scale` page generates redacted fleet diagnostic bundles
  with one click and shows the result.
- Fleet UI: `/scale` page shows upgrade ring distribution and supports
  ring-filtered fleet upgrade/rollback actions.
- Workflow UI: `/scale` page starts, lists, and advances workflow instances
  with role input.
- Scenario UI: `/scale` asset table supports scenario pack install/uninstall
  actions.

## Active Tasks

- Fleet Ops (upgrade/rollback) and event catalog round closed.
- Productization kernels remaining: production approval gate, real
  device/cluster drills, and final acceptance.
- Training/acceptance evidence and production gate preparation.
- Production DDL/deploy approval gate.

## Dependencies

- Next implementation package depends on the persistence and workflow audits.
- W5 security closure depends on Banach's independent review and any required
  correction loop.
- Production deploy and production DDL remain user approval-gated.

## Exit Criteria

- Independent findings are source-referenced and severity-ranked.
- All critical/major security findings are fixed and re-reviewed.
- The next bounded end-to-end workflow has explicit backend, frontend, data,
  and test ownership with no write conflicts.

## Next Action

Final 6 regression recorded in `round69-final6-work-orchestration.md`;
standalone check with E2E passed. Next delivery wave is GitHub Issue/PR
synchronization and real factory replication drills. Production DDL/deploy and
business acceptance remain approval-gated.
