# Phase Gates

| Gate | Meaning | Current status | Evidence required |
|------|---------|----------------|-------------------|
| G0 | Environment and materials accessible | Passed for local implementation | authoritative docs extracted, repo/dependencies readable, capability limits recorded |
| G1 | Requirements and terminology baseline frozen | Passed | Final 5.0/Final 6.0 terminology reconciled; authoritative plan extracted to `authoritative-plan-final6.txt` |
| G2 | Shared contracts frozen | Passed | C1-C9 v1.x frozen; strict OpenAPI audit 232/232; work graph/asset catalog/factory profile audits pass |
| G3 | Environment probes pass | Passed for local standalone scope | PostgreSQL 17.10 and runtime role probed; Docker/Kubernetes tools recorded unavailable |
| G4 | DDL compile/migration tests pass | Passed for standalone | real apply/verify/RLS/audit/rollback/rebuild on PostgreSQL 17.10; unique org-key index verified |
| G5 | Backend infrastructure passes | Passed for standalone base | request transaction/GUC, auth, errors, health, rate limit tests; Jest 76 suites / 362 tests |
| G6 | Core domain modules/APIs pass | Passed locally | 232 routes, 0 unimplemented; work orchestration APIs documented and tested over HTTP |
| G7 | Frontend and command map pass | Validation | Playwright authenticated flow: dispatcher login + command center render on real PG; client Jest 13 suites / 42 tests; PWA manifest/service worker; work console route and layout type-check |
| G8 | Cross-module scenario tests pass | Passed locally | SP-01..SP-08 unit suite + HTTP+PostgreSQL E2E 29/29 on embedded PG 17; Final 6 scenario pack and connector audits pass |
| G9 | Security/performance/regression pass | Validation | security fixes + DB probe pass; control plane writes gated by `EWOH_WORK_WRITABLE`; Jest/lint/typecheck/build pass |
| G10 | Release/rollback/ops ready | Passed locally, production pending | `RELEASE DRILL PASSED` on disposable PostgreSQL 17 (2026-08-04 iteration); security probe OK; GitHub Actions Docker build + PG migration/rollback green; K8s apply and production observability drill pending |
| G11 | Business acceptance and delivery complete | Pending | acceptance signoff |
| G12 | Follow-on phases accepted | Pending | phase acceptance reports |
| G13 | Final project closeout | Pending | closeout package |

## 2026-08-04 P0 Hardening Gate

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
- Full server Jest: 79 suites / 386 tests; client Jest: 13 suites / 46 tests;
  typecheck, lint, standalone production build, repo-facts 33/33, OpenAPI
  245/245, and work graph contract audit 20/20 all pass.
- Independent review found 1 major (worker write-path assignment bypass) and
  7 minors; the major is fixed with `WORKER_STEP_ASSIGNMENT_REQUIRED` guards,
  offline conflict items can be discarded, CI now runs work-indexer with
  `--strict --invariants`, and scan handles a missing body without 500.
- Review fixes are recorded in `round91-review-fixes.md` with server 78/375,
  client 13/46, invariants 0 conflicts, and work-console strict pass.

## 2026-08-04 Onboarding/Mapping Real Gate

- `OnboardingService.run` F0 requires validated site readiness evidence; F2
  publishes connectors; F3 installs scenario packs with idempotent DB/audit.
- `POST /api/scale/mappings/:id/dry-run` maps sample JSON and returns
  `REQUIRED_FIELD_MISSING` / `TRANSFORM_ERROR` with source/target field paths.
- Real PostgreSQL E2E: 29/29 passed with the new onboarding and mapping paths;
  authenticated Playwright: 4/4 passed.
- Full one-click gate with runtime database: `ALL STANDALONE CHECKS PASSED`
  including E2E 32/32 and browser 4/4; server 79/386, client 13/46,
  OpenAPI 245/245.

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
