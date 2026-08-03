# EWOH Task Dependency Graph

## Critical Path

Environment probe -> C1 data / C4 security contracts -> DDL + migrations ->
backend shared transaction context -> master-data domains -> task/resource
state machines -> scenario integration -> independent verification -> release.

Frontend can parallelize on C2/C5 contracts + mocks, but final acceptance is
blocked by real API and scenario gates.

## Waves

| Wave | Parallel work | Waits for | Exit |
|------|---------------|-----------|------|
| W0 | docs, repo inventory, C1-C6 v1, environment probes | - | contracts ready gate |
| W1 | DDL/migrations, backend shared, frontend shell, test harness, CI | W0 | runnable skeleton + temp DB |
| W2 | org/person, devices/embodiment, spatial/model, data governance | W1 | domain CRUD + tests |
| W3 | task/resource, alert/approval, control, event/notification, pages | W2 | operations loop API + pages |
| W4 | AI, reconstruction, gateway, external adapters | W3 | intelligent pilot |
| W5 | scenario packages, RLS, concurrency, perf, UI, security, rollback | W4 | independent validation |
| W6 | migration, gray release, monitoring, training, release | W5 | accepted phase |
| W6-0 | authoritative artifact reconciliation; C1-C9 update; Work Graph schema and path registry | W6 | artifact conflicts cleared or approved |
| W6-1 | indexer, gate engine, resource registry, read-only DAG and evidence drawer | W6-0 | graph matches source files 100% |
| W6-2 | handoff/gate write-back, GitHub Issue/PR sync, CI evidence, resource locks | W6-1 | every state change has actor/commit/evidence |
| W6-3 | Order-to-Delivery, mobile E-SOP, quality trace, ERP/MRP/inventory connectors | W6-0 | connector and scenario TCK pass |
| W6-4 | second factory no-fork replication; device/ERP integration; training | W6-3 | no customer core branch |
| W6-5 | third factory config-driven replication; partner shadow delivery; fleet upgrade | W6-4 | 80% config satisfaction |
| W6-6 | production SLO, DR, supply-chain security, Final 6 acceptance | W6-5 | G10/G11/G13 evidence |
| W7 | P0 hardening: repo-facts gate, unified error contract, data-source vocabulary, transaction reuse, mobile SOP/exception/QC/offline queue/photo/PWA, ValidationPipe, command-map details/error states, state guards, scale idempotency, request-audit correlation, error sanitization | W6-3 | standalone-check ALL PASSED; Jest 76/362; client 13/42; OpenAPI 232/232; repo facts 33/33; real PG E2E 29/29 |

## Package Index

| Package | Owner | Depends on | Status |
|---------|-------|------------|--------|
| WP-ENV-001 | AG-10 | - | Validation |
| WP-CONTRACTS-001 | AG-01..06/30/51 | WP-ENV-001 | Refining |
| WP-DDL-001 | AG-10 | WP-CONTRACTS-001 | Proposed |
| WP-SHARED-001 | AG-11 | WP-DDL-001 | Proposed |
| WP-FRONTEND-SHELL-001 | AG-30 | WP-CONTRACTS-001 | Proposed |
| WP-HARNESS-001 | AG-51 | - | Proposed |
