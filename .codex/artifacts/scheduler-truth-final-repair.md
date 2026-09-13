# Scheduler truth/safety final repair

Date: 2026-09-10
Trace: EWOH-2026-09-10-product-delivery

## Result

The scheduler truth repair is implemented in the shared contract, resource projection, eligibility, candidate, heuristic, CP-SAT, conflict, and client freshness paths. No commit was created. E2E files, migration scripts, and `FactoryOperations` were not edited by this repair.

## Contract and behavior

- `batteryPct` is `number | null` in the scheduler snapshot and CP-SAT request contract.
- `normalizeBatteryPct` accepts only finite numeric values in the inclusive `[0, 100]` range. Missing, `NaN`, infinities, strings, and out-of-range readings become `null`.
- A real `0` remains `0`, so an empty battery is still a real low-battery reading and is never confused with unavailable telemetry.
- Projection no longer uses `d.batteryPct ?? 100` in either `project()` or `projectForSnapshot()`.
- Eligibility rejects `null`/invalid battery with `device_data_unavailable`; it applies the configured threshold only to measured values, preserving the existing `battery_low` behavior for real low readings.
- Candidate and heuristic paths normalize device battery before exposing it or calculating energy cost. Unknown battery cannot produce a healthy default or a finite score.
- Heuristic candidate enumeration and baseline reuse reject missing/invalid/low battery devices.
- CP-SAT request construction preserves `null`, `0`, and valid percentages, adds unavailable/low devices to the worker safety block, removes them from eligible device IDs, and rejects a worker response that attempts to assign one.
- Conflict projections distinguish `device_data_unavailable` from `low_battery`; client Command Map mappings display the new reason as “电量数据不可用”.
- Resource freshness rejects non-finite, invalid, and future timestamps as `UNKNOWN`. The client `classifyFreshness` rejects the same timestamp cases as `STALE`.

## Validation

Passed:

- Focused server scheduler suites: 5 suites, 101 tests.
- Client freshness and conflict mapping suites: 2 suites, 37 tests.
- Python CP-SAT contract and TS/Python parity tests: 22 tests.
- Client TypeScript check: `npm run type:check:client`.
- `git diff --check`.

The broader server scheduler run was started, but many suites could not compile because concurrent unrelated receipt work in the same worktree is incomplete. The observed external errors are in `server/modules/scheduler/execution-receipt-application.service.ts` and its provenance dependency (`Fact` typing and missing/in-progress receipt files), outside this repair's owned surface. The client full type check is likewise blocked by that concurrent receipt work and pre-existing `FactoryOperations/ExecutionFeedback` errors; the repair's client type check passes independently.

## Files changed by this repair

- `ewoh-spark-app/shared/scheduler.ts`
- `ewoh-spark-app/shared/api.interface.ts`
- `ewoh-spark-app/server/modules/scheduler/resource-projection.service.ts`
- `ewoh-spark-app/server/modules/scheduler/eligibility.service.ts`
- `ewoh-spark-app/server/modules/scheduler/candidate-engine.service.ts`
- `ewoh-spark-app/server/modules/scheduler/heuristic-scheduling-solver.ts`
- `ewoh-spark-app/server/modules/scheduler/cp-sat-scheduling-solver.ts`
- `ewoh-spark-app/server/modules/scheduler/scheduler-query.service.ts`
- `ewoh-spark-app/server/modules/scheduler/conflict.service.ts`
- `src/edge_platform/scheduler/cpsat/contract.py`
- Direct regression tests under `server/modules/scheduler/__tests__/`, `client/src/lib/`, and Command Map conflict panels.

The worktree already contained unrelated modifications before this task; those were preserved.
