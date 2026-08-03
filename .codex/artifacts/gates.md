# Phase Gates

| Gate | Meaning | Current status | Evidence required |
|------|---------|----------------|-------------------|
| G0 | Environment and materials accessible | Passed for local implementation | authoritative docs extracted, repo/dependencies readable, capability limits recorded |
| G1 | Requirements and terminology baseline frozen | In progress | trace matrix exists but remains draft/refining |
| G2 | Six shared contracts frozen | Passed | C1-C6 v1.x frozen; strict OpenAPI audit 106/106; requirements trace v1.0 validated |
| G3 | Environment probes pass | Passed for local standalone scope | PostgreSQL 17.10 and runtime role probed; Docker/Kubernetes tools recorded unavailable |
| G4 | DDL compile/migration tests pass | Passed for standalone | real apply/verify/RLS/audit/rollback/rebuild on PostgreSQL 17.10; unique org-key index verified |
| G5 | Backend infrastructure passes | Passed for standalone base | request transaction/GUC, auth, errors, health, rate limit tests; 76 Jest tests total |
| G6 | Core domain modules/APIs pass | Validation | 106 routes, 0 unimplemented; control/resource/world-cursor persisted; approval persistence gap documented |
| G7 | Frontend and command map pass | Validation | Playwright smoke: login, command center, command map, devices, alerts render with real data; QueryClient and replay fixes landed |
| G8 | Cross-module scenario tests pass | Validation | SP-01..SP-08 unit suite + 9 real HTTP+PostgreSQL E2E cases pass |
| G9 | Security/performance/regression pass | Validation | security fixes + DB probe pass; Jest/lint/typecheck/build pass; broader perf/security review pending |
| G10 | Release/rollback/ops ready | Passed locally, production pending | `RELEASE DRILL PASSED` on disposable PostgreSQL 17; GitHub Actions Docker build + PG migration/rollback green; K8s apply and production observability drill pending |
| G11 | Business acceptance and delivery complete | Pending | acceptance signoff |
| G12 | Follow-on phases accepted | Pending | phase acceptance reports |
| G13 | Final project closeout | Pending | closeout package |
