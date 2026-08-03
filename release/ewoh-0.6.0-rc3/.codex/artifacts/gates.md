# Phase Gates

| Gate | Meaning | Current status | Evidence required |
|------|---------|----------------|-------------------|
| G0 | Environment and materials accessible | Passed for local implementation | authoritative docs extracted, repo/dependencies readable, capability limits recorded |
| G1 | Requirements and terminology baseline frozen | Passed | Final 5.0/Final 6.0 terminology reconciled; authoritative plan extracted to `authoritative-plan-final6.txt` |
| G2 | Shared contracts frozen | Passed | C1-C9 v1.x frozen; strict OpenAPI audit 226/226; work graph/asset catalog/factory profile audits pass |
| G3 | Environment probes pass | Passed for local standalone scope | PostgreSQL 17.10 and runtime role probed; Docker/Kubernetes tools recorded unavailable |
| G4 | DDL compile/migration tests pass | Passed for standalone | real apply/verify/RLS/audit/rollback/rebuild on PostgreSQL 17.10; unique org-key index verified |
| G5 | Backend infrastructure passes | Passed for standalone base | request transaction/GUC, auth, errors, health, rate limit tests; 76 Jest tests total |
| G6 | Core domain modules/APIs pass | Passed locally | 226 routes, 0 unimplemented; work orchestration APIs documented and tested over HTTP |
| G7 | Frontend and command map pass | Validation | Playwright smoke: login, command center, command map, devices, alerts render with real data; work console route and layout type-check |
| G8 | Cross-module scenario tests pass | Validation | SP-01..SP-12 unit suite + HTTP+PostgreSQL E2E; Final 6 scenario pack and connector audits pass |
| G9 | Security/performance/regression pass | Validation | security fixes + DB probe pass; control plane writes gated by `EWOH_WORK_WRITABLE`; Jest/lint/typecheck/build pass |
| G10 | Release/rollback/ops ready | Passed locally, production pending | `RELEASE DRILL PASSED` on disposable PostgreSQL 17; GitHub Actions Docker build + PG migration/rollback green; K8s apply and production observability drill pending |
| G11 | Business acceptance and delivery complete | Pending | acceptance signoff |
| G12 | Follow-on phases accepted | Pending | phase acceptance reports |
| G13 | Final project closeout | Pending | closeout package |
