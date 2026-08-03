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
- Control commands now reject terminal-state sends/receipts and duplicate
  in-flight sends; work orchestration handoffs use a strict state machine and
  gate decisions preserve history with idempotent repeats.
- Scale mutations are idempotent for repeated scenario install/uninstall,
  fleet upgrade/rollback to the same target state, and already-resolved
  factory differences.
- Full standalone gate: typecheck, lint, Jest 76 suites / 359 tests, client
  11 suites / 37 tests, repo facts 32/32, OpenAPI 232/232, production build, and
  DDL hygiene all PASSED. Independent review: conditional pass with 0 critical
  and 0 major findings. HTTP+PostgreSQL E2E passed locally on embedded PG 17:
  `29/29` across SP-01..SP-08 and work orchestration acceptance.

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
