# Phase Gates

| Gate | Meaning | Current status | Evidence required |
|------|---------|----------------|-------------------|
| G0 | Environment and materials accessible | Passed for local implementation | authoritative docs extracted, repo/dependencies readable, capability limits recorded |
| G1 | Requirements and terminology baseline frozen | Passed | Final 5.0/Final 6.0 terminology reconciled; authoritative plan extracted to `authoritative-plan-final6.txt` |
| G2 | Shared contracts frozen | Passed | C1-C9 v1.x frozen; strict OpenAPI audit 253/253; work graph/asset catalog/factory profile audits pass |
| G3 | Environment probes pass | Passed for local standalone scope | PostgreSQL 17.10 and runtime role probed; Docker/Kubernetes tools recorded unavailable |
| G4 | DDL compile/migration tests pass | Passed for standalone | real apply/verify/RLS/audit/rollback/rebuild on PostgreSQL 17.10; unique org-key index verified |
| G5 | Backend infrastructure passes | Passed for standalone base | request transaction/GUC, auth, errors, health, rate limit tests; Jest 81 suites / 391 tests |
| G6 | Core domain modules/APIs pass | Passed locally | 232 routes, 0 unimplemented; work orchestration APIs documented and tested over HTTP |
| G7 | Frontend and command map pass | Validation | Playwright authenticated flow: dispatcher login + command center render on real PG; client Jest 13 suites / 42 tests; PWA manifest/service worker; work console route and layout type-check |
| G8 | Cross-module scenario tests pass | Passed locally | SP-01..SP-08 unit suite + HTTP+PostgreSQL E2E 29/29 on embedded PG 17; Final 6 scenario pack and connector audits pass |
| G9 | Security/performance/regression pass | Validation | security fixes + DB probe pass; control plane writes gated by `EWOH_WORK_WRITABLE`; Jest/lint/typecheck/build pass |
| G10 | Release/rollback/ops ready | Passed locally, production pending | `RELEASE DRILL PASSED` on disposable PostgreSQL 17 (2026-08-04 iteration); security probe OK; GitHub Actions Docker build + PG migration/rollback green; K8s apply and production observability drill pending |
| G11 | Business acceptance and delivery complete | Pending | acceptance signoff |
| G12 | Follow-on phases accepted | Pending | phase acceptance reports |
| G13 | Final project closeout | Pending | closeout package |

## 当前权威状态（HEAD @git-head — live git HEAD，见 scripts/truth-source.js）

以下为本仓库的单一、权威当前状态，来自 `CHANGELOG` rc4、`release-manifest` 与 `audit-repo-facts` 的一致聚合。**以下所有历史 `## 2026-08-04 ...` Gate 小节均为历史快照（非权威），权威计数一律以本节为准。**

以下计数一律以 `scripts/collect-repo-facts.js` 从 CI 生成的 JSON 报告（`jest --json --outputFile`）**实时读取**为权威，此处不再硬编码；报告缺失时对应项为"待生成"（本地无报告时 server/client/e2e/browser 为 null）。OpenAPI、work graph、DB 由脚本实时计算。
- server Jest：`由 collect-repo-facts 从 ewoh-spark-app/jest.results.json 实时读取`
- client Jest：`由 collect-repo-facts 从 ewoh-spark-app/client/jest.results.json 实时读取`
- OpenAPI：`由 collect-repo-facts 实时计算（controller/spec 一致）`
- E2E：`由 collect-repo-facts 从 Playwright JSON 报告实时读取（本地 BLOCKED_BY_ENVIRONMENT）`
- browser：`由 collect-repo-facts 从 Playwright JSON 报告实时读取`
- repo-facts：`由 scripts/audit-repo-facts.js --strict 实时审计`
- work graph：`由 tools/work-indexer 实时生成（当前 252 items / 209 edges / 48 actors / 191 evidence / 14 gates / 0 conflicts）`
- DB：`由 db/contracts/schema-manifest.yaml 的生成式 managed_tables 实时计算`
- Pilot readiness：`NOT READY（7 passed / 3 failed / 5 pending）`
- Gate：G0-G6 已通过，G7-G9 为 validation，G10 passed-locally / production-pending，G11-G13 pending

## 历史快照（非权威）: 2026-08-04 P0 Hardening Gate

`bash scripts/standalone-check.sh` passed after the P0 hardening iteration:
typecheck, lint, Jest 76/362, client 13/42, repo-facts 33/33, OpenAPI 232/232,
production standalone build, and DDL hygiene. HTTP+PostgreSQL E2E additionally
passed locally on embedded PG 17: `29/29` (`npm run test:e2e`).

## 2026-08-04 P0 Mobile/Orchestration Gate

- Mobile workbench now filters by `assigned_person_id` and request org with
  fail-closed behavior; typed scan, attachment persistence, offline queue
  states, and `worker` role access are covered by unit tests.
- Evidence files support machine-readable binding; the indexer derives
  `commitSha/branch/buildVersion/envFingerprint/dependencyVersion/testTime/
  verifier/expiresAt` and marks evidence `valid/stale/expired/unbound`.
- `node tools/work-indexer/index.js --root . --invariants` passes 0 conflicts;
  `node tools/work-console/index.js --root . --strict` passes with 0 blocked
  and 0 invariant conflicts; G10-G13 still require human approval.
- Full server Jest: 81 suites / 391 tests; client Jest: 15 suites / 50 tests;
  typecheck, lint, standalone production build, repo-facts 33/33, OpenAPI
  247/247, and work graph contract audit 20/20 all pass.
- Independent review found 1 major (worker write-path assignment bypass) and
  7 minors; the major is fixed with `WORKER_STEP_ASSIGNMENT_REQUIRED` guards,
  offline conflict items can be discarded, CI now runs work-indexer with
  `--strict --invariants`, and scan handles a missing body without 500.
- Review fixes are recorded in `round91-review-fixes.md` with server 78/375,
  client 13/46, invariants 0 conflicts, and work-console strict pass.

## 历史快照（非权威）: 2026-08-04 Onboarding/Mapping Real Gate

- `OnboardingService.run` F0 requires validated site readiness evidence; F2
  publishes connectors; F3 installs scenario packs with idempotent DB/audit.
- `POST /api/scale/mappings/:id/dry-run` maps sample JSON and returns
  `REQUIRED_FIELD_MISSING` / `TRANSFORM_ERROR` with source/target field paths.
- Real PostgreSQL E2E: 29/29 passed with the new onboarding and mapping paths;
  authenticated Playwright: 4/4 passed.
- Full one-click gate with runtime database: `ALL STANDALONE CHECKS PASSED`
  including E2E 33/33 and browser 5/5; server 81/391, client 15/50,
  OpenAPI 247/247.

## 2026-08-04 World Replay Unified Timeline Gate

- Replay merges task/material/quality/alert lanes; event context provides
  before/during/after snapshots; replay-derived items are audited and linked
  to source events via `ewoh_event_chain`.
- Unit tests added for replay merging, context selection, and replay item
  creation; real PostgreSQL E2E now 30/30.

## 2026-08-04 E-SOP Sign-off Gate

- SOP versioning, publish, diff, mandatory step sign-off, and tool/material
  confirmation are implemented and persisted without new DB tables.
- Real PostgreSQL E2E now 31/31; server unit tests cover sign-off rejection
  and accepted signature persistence.

## 2026-08-04 Quality Scheme Gate

- Quality scheme registry, publish, auto-match, required check enforcement,
  and result consistency are implemented and persisted.
- Real PostgreSQL E2E now 32/32; server unit tests cover stage mismatch,
  missing required checks, result mismatch, and passing checks.

## 2026-08-04 Slow Query Observability Gate

- DB transactions can be bounded by `EWOH_DB_STATEMENT_TIMEOUT_MS` and slow
  transactions are recorded with requestId and duration.
- Slow-query API and Prometheus counter are covered by unit tests and real PG
  E2E.

## 历史快照（非权威）: 2026-08-04 Frontend Performance Gate

- Routes are lazy-loaded; standalone production build emits per-page chunks.
- `getWorldState`/`getReplay` accept `AbortSignal` and are wired through
  React Query in CommandMap.
- Browser authenticated flows pass 4/4 after the lazy-loading change.
- Work graph after frontend wave: 246 items / 33 edges / 103 evidence /
  0 invariant conflicts.

## 2026-08-04 Role Workbench Gate

- Role aggregation API covers operator, team lead, quality, equipment, and
  manager views with real production data.
- `/role-workbench` page renders role tabs, metrics, and lists.
- E2E 33/33 and authenticated browser 5/5 passed.

## 2026-08-04 Progressive List Gate

- Progressive list helpers are unit-tested.
- Role workbench tables slice to 50 and support load-more without replacing
  the data source.

## 历史快照（非权威）: 2026-08-04 Pilot Readiness Rerun

- Current code: 7 passed, 3 failed (Docker/Kubectl/Helm unavailable locally),
  5 pending external approval/input.
- Result: `PILOT READINESS: NOT READY`; production readiness remains gated.
- Work graph after pilot rerun: 249 items / 36 edges / 106 evidence /
  0 invariant conflicts.

## 2026-08-04 Replay Context UI Gate

- Event center can fetch and display replay before/during/after context.
- Replay context summarizer is unit-tested.

## 历史快照（非权威）: 2026-08-04 Git Sync Apply Gate

- Apply endpoint is exposed but fails closed without `EWOH_WORK_WRITABLE`.
- Real GitHub creation remains approval-gated by environment and human
  decision.
- Work graph after git sync apply wave: 251 items / 108 evidence /
  0 invariant conflicts.

## 2026-08-04 Final Standalone Gate

- Full one-click gate with real PostgreSQL: `ALL STANDALONE CHECKS PASSED`.
- Server 81/391, client 15/50, E2E 33/33, browser 5/5, OpenAPI 253/253.
- Work graph: 252 items / 109 evidence / 0 invariant conflicts.
