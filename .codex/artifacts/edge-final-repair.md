# Edge final repair evidence

- trace_id: `EWOH-2026-09-10-product-delivery`
- role/status: Execution Agent / completed; evidence is `confirmed_current`.
- source_refs: user delegation; `.codex/artifacts/current-delivery-state.json` read first; current scoped source, diffs, and test runs below.

## Result and review

- `DemoSimulator` retains one worker, serializes start/stop state, ignores duplicate starts, joins pending writes on external stop, and resets its stop event for restart. Sampling uses interruptible event waiting. Simulation assembly test now stops the worker before closing/removing its temporary SQLite database.
- `SchedulingRepository.save_plan` assigns deterministic fallback child IDs from the JSON-encoded `(plan_id, task_id)` pair. Explicit IDs remain unchanged; collisions now abort instead of moving another plan's child. Parent update, complete child replacement, and removal of obsolete children share one storage lock and SQLite transaction. Any write/conversion/constraint failure rolls back the entire save. `get_plan` reads parent and children in one transaction, including across connections.
- `_validate_world_state` raises `PlanStaleError` when the original snapshot cannot be recovered. Confirm and execute fail before creating reservations, assignments, or decisions. Existing hydration/task-sync success fixtures now persist an original snapshot.
- Self-review covered shutdown ordering, restart identity, rollback on an injected second-child failure, duplicate/explicit IDs, removed children, concurrent reader consistency, hydration serialization, and fail-closed side effects. No remaining scoped defect found.
- Existing uncommitted work was preserved. The only edit to `scheduler_service.py` is replacing the missing-snapshot early return with `PlanStaleError`. No commits, UI changes, real equipment control, or expanded Edge authority.

## Assumptions and decisions

- The supported plan persistence implementation is the current SQLite `edge.storage.Storage`; `stubs.Storage` aliases it. Its public parent/child writes each commit and use a non-reentrant lock, so wrapping those methods cannot provide atomicity. Transactional plan SQL stays in the owned repository file and uses the existing connection/lock and row decoders.
- A candidate task has one fallback child identity per plan. Multiple occurrences need distinct explicit IDs; duplicate IDs reject the whole save. Generated persistence IDs are kept out of the parent candidate snapshot to preserve `CandidateAssignment` hydration.
- Callers must stop the simulator before closing storage. External stop waits for in-flight storage work without a timeout; a worker calling stop on itself only signals shutdown and does not self-join.

## Files owned and changed

- `src/edge_platform/stubs.py`
- `src/edge_platform/scheduler/repository.py`
- `src/edge_platform/scheduler/scheduler_service.py` — targeted `_validate_world_state` only
- `src/edge_platform/tests/test_demo_simulator.py` — new lifecycle regressions
- `src/edge_platform/tests/test_repository.py`
- `src/edge_platform/tests/test_scheduler_hydrate.py`
- `src/edge_platform/tests/test_task_assignment_sync.py`
- `tests/test_production_assembly.py`
- `.codex/artifacts/edge-final-repair.md`

## Tests

- Reproduction before fixes: focused lifecycle/repository/hydration/task-sync run produced **8 failed, 17 passed**; failures cover all three reported defects plus stale children and explicit-ID stealing.
- Full suite: `PYTHONPATH=src python3 -m pytest -q src/edge_platform/tests tests -W error::pytest.PytestUnhandledThreadExceptionWarning` → **1710 passed, 11 skipped, 11 warnings in 54.90s**. Warnings are existing deprecated scheduling API calls; no unhandled-thread warning. Two additional repository tests were added afterward; production code did not change after this run.
- Final focused run: `PYTHONPATH=src python3 -m pytest -q src/edge_platform/tests/test_demo_simulator.py src/edge_platform/tests/test_repository.py src/edge_platform/tests/test_scheduler_hydrate.py src/edge_platform/tests/test_task_assignment_sync.py tests/test_production_assembly.py -W error::pytest.PytestUnhandledThreadExceptionWarning` → **32 passed in 0.32s**, including those two additional tests.
- `ruff check src/edge_platform/stubs.py src/edge_platform/scheduler/repository.py src/edge_platform/tests/test_demo_simulator.py src/edge_platform/tests/test_repository.py src/edge_platform/tests/test_scheduler_hydrate.py src/edge_platform/tests/test_task_assignment_sync.py tests/test_production_assembly.py --output-format concise` → **All checks passed**.
- `git diff --check` → **passed**.

## Risks and trace_requests

- SQLite schema/private connection coupling is deliberate within this ownership boundary; future Storage schema changes must keep repository SQL aligned. The lower-level `Storage.save_plan_assignment` helper retains its legacy fallback outside this scope; runtime plan writes should continue through `SchedulingRepository.save_plan`.
- Existing already-collided child rows are not backfilled automatically; resaving the affected plan from its intact candidate snapshot rebuilds its children. Plans lacking an original snapshot now require regeneration before confirmation/execution.
- A permanently blocked storage write would also block external simulator stop. This preserves the guarantee that stop does not return while a worker can still write.
- trace_requests: none blocking. Principal should retain these maintenance/data-repair limitations with the delivery trace; this evidence establishes local Python/SQLite behavior and simulation only.
- next_entrypoint: Principal integrates this evidence with the separate production PostgreSQL/browser verification; no further Edge repair action is pending.
