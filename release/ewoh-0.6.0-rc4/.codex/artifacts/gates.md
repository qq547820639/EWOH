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
