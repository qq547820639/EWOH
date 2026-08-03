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
| W0 | docs, repo inventory, C1-C6 v1, environment probes | existing materials | contracts ready gate |
| W1 | DDL/migrations, backend shared, frontend shell, test harness, CI | W0 | runnable skeleton + temp DB |
| W2 | org/person, devices/embodiment, spatial/model, data governance | DDL + shared | domain CRUD + tests |
| W3 | task/resource, alert/approval, control, event/notification, pages | state machines + master data | operations loop API + pages |
| W4 | AI, reconstruction, gateway, external adapters | stable world + ops data | intelligent pilot |
| W5 | scenario packages, RLS, concurrency, perf, UI, security, rollback | integration candidate | independent validation |
| W6 | migration, gray release, monitoring, training, release | release gate | accepted phase |

## Package Index

| Package | Owner | Depends on | Status |
|---------|-------|------------|--------|
| WP-ENV-001 | AG-10 | none | Validation |
| WP-CONTRACTS-001 | AG-01..06/30/51 | WP-ENV-001 evidence | Refining |
| WP-DDL-001 | AG-10 | WP-CONTRACTS-001 C1/C4 | Proposed |
| WP-SHARED-001 | AG-11 | WP-DDL-001 | Proposed |
| WP-FRONTEND-SHELL-001 | AG-30 | WP-CONTRACTS-001 C2/C5 | Proposed |
| WP-HARNESS-001 | AG-51 | none | Proposed |
