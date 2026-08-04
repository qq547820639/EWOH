---
workItemIds: T-153,T-154,T-155,T-156,T-157
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

# Round 69 - Final 6.0 Work Orchestration Control Plane

Date: 2026-08-04

## Delivered

- Final 6.0 authoritative plan extracted to
  `.codex/artifacts/authoritative-plan-final6.txt`; decision D-033 recorded.
- C7 Work Graph, C8 Asset Catalog, and C9 Factory Profile schemas plus
  artifact path registry and strict audit scripts.
- File-backed Work Graph indexer, gate engine, resource registry, and handoff
  service under `tools/`.
- NestJS `/api/work/*` control plane APIs and `openapi/work-orchestration.yaml`.
- React `/work-orchestration` console with DAG, gates, evidence, agents, risks,
  resources, handoffs, and asset catalog tabs.
- Final 6 P0 scenario packs, ERP connectors, and mapping manifests under
  `catalog/`.
- Offline-first GitHub Issue/PR sync plan under `tools/git-sync/`, exposed by
  `GET /api/work/git-sync` and rendered in the console Git Sync tab.
- Factory replication acceptance TCK under `tools/factory-replication/` with
  `contracts/factory/replication-report.schema.json` and passing/failing
  fixtures.
- Factory site-readiness evaluator under `tools/factory-replication/site-readiness.js`
  with `contracts/factory/site-readiness.schema.json` and ready/not-ready
  fixtures.
- Work console UX deepening: DAG pan/zoom, node search, gate status filter,
  evidence type/result filters, and backend `q`/`limit`/`offset` query params.
- Resource lock expiry auto-release in the work orchestration API.
- DAG node search automatically switches to all-scope rendering so a matching
  task/package node is visible even when wave/gate filters are active.
- Evidence content preview API (`GET /api/work/evidence/:id/content`) with
  bounded 500-line reads and an inline preview drawer in the evidence tab.
- Batch gate decisions (`POST /api/work/gates/batch-decision`) and resource
  lock expiry countdown in the console.
- Factory site readiness control plane: `GET /api/work/site-readiness` scans
  `catalog/factory-sites/*.json`, evaluates Go/No-Go, and renders a console
  tab with ready/failed summaries.
- Handoff state workflow: `POST /api/work/handoffs/:id/state` persists
  accepted/rejected/closed transitions to the markdown record; console shows
  receive/reject/close actions.
- Executable client Jest runner (`client/jest.config.cjs`, `npm run test:client`)
  and a 100-entry audit hash chain stress case.
- Deployment env wiring for `EWOH_WORK_ARTIFACTS_DIR`,
  `EWOH_WORK_TOOLS_DIR`, and `EWOH_WORK_WRITABLE` in compose, K8s, Helm, and
  the standalone env example.

## Verification Evidence

### Standalone check

`bash scripts/standalone-check.sh` passed end to end:

- Type check server + client passed.
- ESLint, stylelint, and full type check passed.
- Jest: 74 suites / 332 tests passed (git-sync, factory replication,
  site readiness, lock expiry, query filters, and audit-chain stress coverage).
- Client Jest: 7 suites / 27 tests passed through the standalone gate.
- Work indexer: 202 items / 21 edges / 48 actors / 69 evidence / 14 gates /
  0 conflicts.
- Gate engine: G10-G13 correctly remain human-approval-gated.
- OpenAPI strict audit: 231 controller operations / 231 documented / 0
  undocumented / 0 unimplemented.
- Work graph, asset catalog, and factory profile audits passed.
- Git sync plan: 188 task/package/wave items, 0 linked, 188 pending issue/PR
  records in offline mode; live creation requires explicit approval.
- Factory replication fixture: passing fixture accepted, failing fixture
  rejected; site readiness ready/not-ready fixtures validated; factory
  contract audit raised to 20 checks.
- Release bundle `release/ewoh-0.6.0-rc3` built with Final 6 tools, catalog,
  artifacts, and work control plane assets; 1537 files, checksums generated,
  release review 34/34.
- Helm chart audit: 128 checks; deploy artifact verifier: 66/66.
- Standalone production build passed.
- DDL plans and standalone DDL hygiene passed.

### E2E HTTP + PostgreSQL

`npm run test:e2e` passed 29/29 scenarios against local PostgreSQL 17.10,
covering auth, RBAC, RLS isolation, MES P0, OEE/andon, ERP, scale, workflow,
feature flags, parameters, AAS, tracing, world cursor, control persistence,
and work orchestration role gating.

### Local gate sweep (2026-08-04)

- Scenario TCK: 8 gates passed.
- Connector TCK: 32 checks passed.
- AAS TCK: 7 checks passed.
- Rego policy-as-code TCK: 4 checks passed.
- Deployment TCK: 4 gates passed (deploy artifacts 66/66, Helm 128, release
  review 33/33, Rego).
- Cross-tenant TCK: HTTP + PostgreSQL org isolation E2E passed 29/29.
- Perf smoke: `/health/live` 1000 requests / 50 concurrency, 1368 QPS,
  p50 24.08ms, p95 74.80ms, 0 failures.
- Ops backup/restore: 57 tables exported, restored, and verified; identity
  sequence advanced after restore; `standalone-ops-check.sh` PASSED.
- Environment probe refreshed in `.codex/artifacts/inventory/environment.md`.
- Python evidence: unittest 667 passed, pytest 120 passed, ruff clean.
- One-command `release-drill.sh` passed on disposable PostgreSQL 17, including
  DDL/RLS/audit/rollback/rebuild, standalone check, client Jest, E2E, build,
  and DDL hygiene.
- Pilot readiness: intentionally NOT READY with documented external blockers
  (Docker/Kubectl/Helm unavailable; pilot factory, production approval,
  training completion, acceptance signoff, real device config pending).

### PostgreSQL 17 DDL/RLS/audit/rollback/rebuild

`scripts/standalone-postgres-check.sh` passed against the current worktree:

- Generated standalone DDL package.
- Applied 51 managed tables: 51 RLS-enabled, 0 missing org defaults, 0
  authenticated DML grants, audit/world identity sequences, audit function.
- Idempotent reapply passed.
- Runtime role `LOGIN, NOBYPASSRLS` verified; direct user/org reads denied;
  SECURITY DEFINER lookup works.
- Org A/B RLS positive/negative tests and global admin read passed.
- Two-entry SHA-256 audit chain recomputed; cross-org append and direct
  tampering denied.
- Destructive rollback left 0 EWOH relations/functions.
- Rebuild after rollback passed.

### HTTP read-only smoke (`:3102`)

- `POST /api/auth/login` with DB-backed admin user returned access token.
- `GET /api/work/graph` returned canonical graph with 0 conflicts.
- `GET /api/work/overview`, `/gates`, `/resources`, and `/catalog` returned
  real indexed data.
- `POST /api/work/handoffs` returned 400 because `EWOH_WORK_WRITABLE` is
  disabled.
- `/login` served the standalone SPA with 200.

### HTTP writable smoke (`:3103`)

With a disposable artifacts fixture and `EWOH_WORK_WRITABLE=true`:

- `POST /api/work/handoffs` persisted a markdown handoff record.
- `POST /api/work/gates/G2/decision` persisted `approved` and the gates API
  returned `humanDecision=approved`.
- `POST /api/work/resources/RES-node-js/lock` persisted a resource lock; lock
  file appeared under `work/locks/`.

### Browser regression

Playwright against system Chrome:

- `/work-orchestration` rendered title `执行控制台`, eight tabs, DAG SVG nodes,
  and 14 gate rows after switching to the gate tab.
- Git Sync tab rendered 188 tracking rows with no console errors; screenshot
  `output/playwright/work-orchestration-git-sync.png`.
- No console errors or page errors observed.
- Screenshot: `output/playwright/work-orchestration.png`.

### Release and scenario gates

- `npm run release:review`: 34/34 checks passed, release review PASSED.
- `node scripts/scenario-tck.js`: 8 gates passed.
- Client Jest: 7 suites / 27 tests passed.
- Release bundle: `release/ewoh-0.6.0-rc3` (1537 files) with
  `SHA256SUMS.txt`; package release review passed.

## Remaining Blockers

- GitHub Issue/PR synchronization and offline file fallback refinement.
- Two real factory replication drills with VAL-62 independent acceptance.
- Partner shadow delivery and production SLO/observability drills.
- Production DDL/deploy and G10-G13 human approvals.
