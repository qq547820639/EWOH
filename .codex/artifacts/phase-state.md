# EWOH Phase State

Updated: 2026-08-03
Trace: EWOH-2026-08-03-principal-001

## Current Phase

Final 5.0 productization: scale kernel, connector/scenario catalog, asset
conformance, factory profile replay, fleet upgrade/rollback, and the
AsyncAPI/CloudEvents event catalog are implemented and validated. Next is the
remaining productization kernels (connector SDK/runtime, mapping/event
contracts, Helm/factory values, OTel resource attributes) before the
production approval gate.

## Just Completed

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

Close the remaining Final 5.0 productization kernels in bounded waves, rerun
the standalone check and release drill, then prepare Scale Release evidence.
Production DDL/deploy remain approval-gated.
