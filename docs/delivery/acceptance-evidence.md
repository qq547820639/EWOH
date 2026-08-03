# EWOH Acceptance Evidence

Status: validated v1.2 (2026-08-03 hardening wave)
Owner: AG-00/AG-41

## Automated Evidence

- Python unittest: 667 passed.
- Python repo contract tests: 69 passed.
- NestJS Jest: 254 passed across 60 suites (includes SP-01..SP-08 scenario
  suite and event catalog, Helm chart, Golden Factory, and Mapping DSL
  contract tests).
- Client Jest: 20 passed across 6 suites.
- HTTP + PostgreSQL E2E: 21 passed (auth, RBAC, refresh rotation/logout, org
  isolation, control/resource/world persistence, canonical UnifiedExoFrame
  ingestion, gamification allocation persistence, approval persistence,
  system config org scoping, complete MES work order execution, and
  OEE/andon SLA escalation, ERP inbound/outbound/reconcile, and scale
  template publish/install/asset registration, scenario install + fleet
  upgrade/rollback, the event catalog API, `/metrics` resource attributes, and
  policy evaluation).
- NestJS type check, lint, and Standalone production build: passed.
- One-click `scripts/standalone-check.sh`: passed with E2E, OpenAPI strict
  audit, DDL plans, and standalone DDL hygiene.
- OpenAPI contract: 164 controller operations documented, 0 undocumented,
  0 unimplemented; `openapi/route-manifest.json` generated.
- Full release drill: `RELEASE DRILL PASSED` against disposable PostgreSQL 17,
  including migration/RLS/audit/rollback/rebuild, 176 Jest tests, 107/107
  OpenAPI, 14/14 HTTP+PostgreSQL E2E, standalone build, and DDL hygiene.
- Ops drill: `ALL STANDALONE OPS CHECKS PASSED` with logical backup/restore of
  54 `ewoh_*` tables, exact row-count verification, and post-restore identity
  sequence smoke.
- Performance smoke: 1000 requests / 50 concurrency, 4943 qps, p95 17.50ms,
  0 failures against the built standalone API on PostgreSQL 17.
- Business-path performance smoke: `GET /api/dashboard/overview`,
  200 requests / 25 concurrency, 514 qps, p95 60.93ms, 0 failures.
- Prometheus metrics: `GET /metrics` returns text/plain counters for HTTP
  requests, active requests, uptime, and database readiness.
- Deploy artifact verification: Kubernetes manifests, docker-compose, and
  Dockerfiles validated locally with 66 checks / 0 failures.
- MES P0 production execution: work order -> steps -> material consumption ->
  quality inspection -> report -> review -> handover -> completion persisted
  to PostgreSQL with org scoping and audit.
- OEE/andon: device status timeline, OEE calculation with downtime breakdown,
  andon state machine, and SLA escalation notification persisted to
  PostgreSQL with org scoping and audit.
- ERP connector: idempotent inbound orders, outbound message queue with ack,
  and reconciliation summary persisted to PostgreSQL with org scoping.
- Quality trace: `GET /api/mes/work-orders/{id}/trace` returns work order,
  step, material, and inspection nodes/links.
- Mobile workbench API: assigned-step list, order scan, and step transitions
  delegate to the MES state machine.
- Mobile workbench UI: React page with QR/order scan, assigned-step list, and
  start/report/review/handover actions wired to the API.
- Scale kernel: factory template registry with inheritance/lifecycle, factory
  profile install, and asset package registry; managed tables 51, RLS 51.
- Connector/scenario catalog: connectors and scenario packs register on the
  asset package registry; one published template installs multiple factory
  profiles without a code fork.
- Conformance TCK: asset packages run package-type consistency checks.
- Factory profile replay: template config merges with profile overrides,
  status becomes `replayed`, and the operation is audited.
- Scenario install gate: a scenario pack must pass its TCK before the package
  can be installed; failed installs return 400.
- Fleet upgrade/rollback: `POST /api/scale/fleet/upgrade` and
  `/api/scale/fleet/rollback` update all org-visible factory profiles and write
  audit entries; E2E verifies every profile is `rolled_back` after rollback.
- Event catalog: AsyncAPI 2.6 + CloudEvents 1.0 contract defines 13 event
  types and 13 channels; `GET /api/events/catalog` and
  `GET /api/events/catalog/:type` are served to authenticated users; a strict
  contract audit is wired into `standalone-check.sh` and Docker runtime images.
- Helm deployment factory: `deploy/cloud/helm/ewoh` v0.1.0 renders Namespace,
  ConfigMap, migration Job hook, Deployment, Service, Ingress, HPA, PDB, and
  local-storage PVC; factory ID/name/upgrade-ring values are carried into the
  ConfigMap; chart never generates secrets from defaults; static audit
  `scripts/verify-helm-chart.js` passes 123 checks and is covered by a Jest
  contract test.
- Golden Factory Profile: versioned manifest covers 7 modules, 3 required
  connectors and 4 scenario packs; `POST /api/scale/golden-factory/install`
  publishes the template, installs TCK-passing scenario packs, and installs or
  reuses an org-scoped factory profile; E2E verifies idempotent reuse and
  persisted status; contract audit passes 47 checks.
- Mapping DSL and Schema Registry: `contracts/mapping/mapping-schema.json`
  defines versioned mapping contracts; mapping assets register through the
  asset package registry; mapping TCK validates source/target schema refs,
  non-empty rules, rule paths, and schema version; E2E verifies register,
  list/detail, conformance, and org scoping; contract audit passes 10 checks.
- Upgrade rings and fleet ops: fleet upgrade/rollback support ring-filtered
  staging, `GET /api/scale/fleet/status` exposes the org fleet registry, and
  `POST /api/scale/fleet/support-bundle` returns a redacted audited diagnostic
  bundle; `contracts/state-machines/fleet.yaml` freezes ring and status
  transitions; E2E verifies shadow-ring install/upgrade/rollback, fleet status,
  and support bundle generation.
- OTel resource attributes: `GET /metrics` renders `ewoh_resource_info` with
  factory id/name, upgrade ring, release version, and region; the env contract
  is present in standalone, Compose, Kubernetes, and Helm deployment artifacts.
- Compatibility catalog: `GET /api/scale/compatibility` evaluates asset/core
  ranges with prerelease-aware semver matching; E2E verifies a legacy connector
  with an incompatible range is flagged while conformant packages remain
  compatible.
- Policy engine: `contracts/policy/policy-schema.json` defines the policy
  contract; `POST /api/policies/evaluate` validates and evaluates rule sets
  against contexts; E2E verifies the canonical operator-safety policy denies
  high-risk dispatch and allows safe contexts.
- Template config diff preview: `POST /api/scale/templates/:id/diff-preview`
  returns inherited and merged config with added/changed/removed key diffs;
  E2E verifies a published template preview without mutation.
- Connector runtime: versioned connector manifests load, validate, health-check
  and redact config through `src/edge_platform/connectors`; sample
  exoskeleton-frame and equipment-state packages cover the connector SDK
  contract; 10 new Python tests pass.
- Browser regression: Playwright verified login, command center, command map,
  devices, and alerts pages with real data; the RC2 run also confirmed org
  scope resolves without fallback warnings.
- Org scope hardening: `ewoh_find_org` / `ewoh_find_org_children`
  `SECURITY DEFINER` lookups resolve the hierarchy before request GUCs; the
  security probe verifies direct org-table reads are RLS-filtered and the
  controlled lookup returns the tenant.
- Performance smoke: 1000 requests / 50 concurrency on `/health/live`,
  6718 qps, p95 14.63ms, 0 failures.
- Approval persistence: instances/steps/actions mapped to
  `ewoh_event`/`ewoh_event_chain`/`ewoh_audit_log` and verified in E2E.
- Ingestion protocol: canonical `UnifiedExoFrame` nested fields map to
  `ewoh_telemetry`, M2M `X-Org-Id` establishes tenant context, duplicate
  `raw_ref` frames are skipped, and `assist_level` is numeric in DDL and
  runtime schema.

## PostgreSQL 17.10 Standalone Evidence

- Applied standalone schema, seed, user auth, and non-owner runtime role to the
  local PostgreSQL 17.10 test instance.
- Reapplied all idempotent migrations and verified 48 managed tables, 48 RLS
  tables, zero missing `org_id` columns, zero nullable managed `org_id`
  columns, zero missing request organization defaults, zero loose policies,
  and zero `authenticated` or `anon` business-table grants.
- Verified `ewoh_api` is a login role without superuser, database creation,
  role creation, replication, or RLS bypass privileges. Direct `ewoh_user`
  reads are denied; controlled `SECURITY DEFINER` lookup succeeds.
- Verified organization A positive read/update, organization B negative
  read/update/insert, global administrator cross-organization read, audit
  append controls, direct audit tamper denial, and two-entry SHA-256 chain
  recomputation.
- Performed destructive standalone rollback and observed zero remaining EWOH
  relations/functions, then rebuilt and repeated all verification successfully.

## HTTP Authorization Evidence

- Started the rebuilt standalone API on `127.0.0.1:3101` using the non-owner
  `ewoh_api` database role.
- `/health/live` and `/health/ready` returned 200 without authentication;
  unauthenticated `/api/organization` returned 401.
- Three temporary A/B/global users logged in successfully; access tokens were
  rejected by the refresh endpoint and refresh tokens were rejected by protected
  APIs. A valid refresh token issued a usable access token.
- Organization A and B could read and update only their own rows. Both cross-org
  updates returned 404, while the global administrator could read A, B, and the
  A-created child organization.
- `POST /api/organization` omitted `org_id`; an owner-side database query proved
  PostgreSQL stored the request's `app.current_org_id` value. Temporary users and
  organizations were removed after verification.

## HTTP Audit Evidence

- Added a database audit sink that calls the `ewoh_append_audit_log`
  SECURITY DEFINER function inside the request transaction.
- Added `GET /api/audit` with pagination, entity/action/actor filters, and the
  SHA-256 chain fields; unauthenticated access returned 401.
- Organization create/update and personnel create/update now append redacted
  audit entries through `AuditService`.
- Live verification: two temporary organizations created data through HTTP;
  `/api/audit` for organization A returned only A's `organization.create` and
  `organization.update` rows, organization B returned only B's create row, all
  rows carried 64-character `hash`/`prev_hash` values, and filtered queries
  returned exactly the matching row. Temporary data was removed afterward.

## GitHub Actions Evidence (2026-08-03)

- Branch `codex/rc1-ci-full`, commit `7474121`.
- `standalone`: success, including Docker image build, PostgreSQL 17
  migration/RLS/audit/rollback, E2E 11/11, OpenAPI 106/106.
- `test`: success (Python unittest, pytest, ruff).
- `security`: success (bandit `-ll`).

## Scenario Coverage

- SP-01..SP-08 retain unit smoke coverage under `test/scenarios`.
- Real HTTP + PostgreSQL E2E covers health, 401/403 RBAC, refresh token
  rotation/revocation, org A/B isolation, world cursor expiry, control request
  persistence, approval instance/step/audit persistence, and org-scoped system
  config.
- Device contract routes `/api/devices*` are enforced for
  `global_admin`/`dispatcher`/`device_ops` and verified in E2E.

## Pending

- Real device/gateway integration evidence.
- Local container/Kubernetes build/apply evidence (Docker CLI unavailable in
  the current environment; CI workflow includes Docker image build steps).
- Production deployment, monitoring, training delivery/signoff (material
  ready v1.1), and user signoff.
