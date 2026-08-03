# EWOH Release Checklist

Status: validated v1.1 (2026-08-03)
Owner: AG-00/AG-51

## Gates

| Gate | Meaning | Status | Evidence |
|------|---------|--------|----------|
| G0 | Materials accessible | Passed | docs extracted, repo probed |
| G1 | Requirements baseline | Validated | requirements-trace v1.0 |
| G2 | Six contracts | Passed | C1-C6 frozen; OpenAPI strict audit 106/106 |
| G3 | Environment probes | Passed | environment.md |
| G4 | DDL compile/migration | Passed (standalone local) | PG 17 apply/verify/rollback/rebuild; 48 tables, 48 RLS |
| G5 | Backend shared infra | Passed | shared infra + request transaction/GUC tests |
| G6 | Core domain APIs | Passed (standalone) | 106 routes; control/resource/world/approval persisted |
| G7 | Frontend centers | Passed | Playwright smoke across 5 key screens; build OK |
| G8 | Scenario packages | Passed | unit smoke + 11 real HTTP+PostgreSQL E2E cases |
| G9 | Security/performance | Passed (local) | security probe, 6718 qps / p95 14.63ms smoke |
| G10 | Release/rollback | Partial | runbook, DDL rollback drill; container/K8s and production drill pending |
| G11 | Acceptance | Pending | requires production DB and user signoff |
| G12 | Follow-on phases | Pending | |
| G13 | Closeout | Pending | |

## Cloud Product Gates (added 2026-08-03)

| Gate | Requirement | Status |
|------|-------------|--------|
| C1 | Standalone bootstrap without Miaoda runtime | Passed |
| C2 | Client without Miaoda toolkit | Passed |
| C3 | JWT/RBAC + bcrypt user table | Passed |
| C4 | Redis rate limit | Passed |
| C5 | Docker + Compose + K8s manifests | Written; local build pending Docker CLI |
| C6 | CI/CD workflow | Passed |
| C7 | Standalone DDL (public, no user_profile) | Generated + applied on local PG 17 |
| C8 | Concurrency smoke evidence | Passed |
| C9 | Production load/HA verification | Pending |
| C10 | File service with local + S3-compatible storage | Implemented; live object storage pending credentials |

## Before Production

- User approval for DDL, deployment, credentials, and irreversible changes.
- Privileged temporary PostgreSQL run of apply/verify/rollback.
- Backup and rollback drill.
- Monitoring and alerting configured.
- Acceptance signoff by business and safety owner.
