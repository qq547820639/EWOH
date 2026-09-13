# Edge review repairs

- trace_id: `EWOH-2026-09-10-edge-review-repairs`
- role/status: Principal / completed
- source_refs:
  - User request
  - `.codex/artifacts/independent-final-review.md`
  - `.codex/artifacts/current-delivery-state.json`
  - Current worktree source and focused test output
- scope: bounded Edge repairs only
- constraints honored: no commits, no production actions, no NestJS/frontend/schema/script changes

## Repairs

### P1: deterministic plan evaluation rejects unknown or unusable stations

`evaluate_plan` now validates each assigned station against the snapshot and emits explicit blockers:

- `STATION_MISSING` when the assignment station is absent.
- `STATION_UNAVAILABLE` when availability, active/online flags, or status indicate the station cannot accept work.
- `STATION_CAPACITY` when existing occupancy fills capacity, capacity is invalid/non-positive, or concurrent assignment windows exceed available capacity.

The simulation storage snapshot now exposes its known `DOCK` and `PACKING` stations so existing closed-loop fixtures carry the same resource graph that scheduling produces.

### P2: source timestamp provenance survives Edge snapshot restart

`WorldStateSnapshot` now carries `source_timestamps`. Edge SQLite snapshot persistence stores a versioned metadata object:

```json
{"version": 1, "source_timestamps": {...}}
```

Existing databases receive the `metadata_json` column idempotently at startup. Snapshot readback supports legacy rows with empty provenance and rejects unsupported metadata versions. The regression closes and reopens SQLite before hydrating and evaluating a persisted plan.

### Replay missing-store single response regression

The Principal’s existing `replay.py` fix is preserved: missing-store handling calls `_new_error` and returns a truthy handled marker instead of using the `None` response as the dispatch marker. The regression routes all six world endpoints through the real registry dispatcher with a handler whose `_new_error` returns `None`, then asserts:

- no `AttributeError`;
- exactly one `world_store_unavailable` response;
- HTTP behavior remains 503 in the live fixture.

A mutation check temporarily substitutes the old `return None, h._new_error(...)` behavior and confirms all six endpoint subtests fail, proving the regression catches the double-dispatch/dereference defect.

## Exact tests and checks

- `PYTHONPATH=src python3 -m pytest -q src/edge_platform/tests/test_plan_evaluation.py src/edge_platform/tests/test_snapshot_provenance.py src/edge_platform/tests/test_closed_loop.py src/edge_platform/tests/test_world_api.py src/edge_platform/tests/test_scheduler_hydrate.py src/edge_platform/tests/test_repository.py src/edge_platform/tests/test_scheduling.py src/edge_platform/tests/test_scenario.py src/edge_platform/tests/test_task_assignment_sync.py src/edge_platform/tests/test_scheduler_ownership.py src/edge_platform/tests/test_storage_tables.py src/edge_platform/tests/test_scheduling_api.py tests/test_production_assembly.py -W error::pytest.PytestUnhandledThreadExceptionWarning` — **187 passed in 4.19s**.
- Mutation check using `unittest.mock.patch` against the old replay helper — **all 6 endpoint subtests rejected the legacy behavior; no implementation file changed**.
- `ruff check src/edge_platform/edge/storage.py src/edge_platform/scheduler/models.py src/edge_platform/scheduler/world_state.py src/edge_platform/scheduler/plan_evaluation.py src/edge_platform/scenario/closed_loop.py src/edge_platform/routes/replay.py src/edge_platform/tests/test_closed_loop.py src/edge_platform/tests/test_world_api.py src/edge_platform/tests/test_plan_evaluation.py src/edge_platform/tests/test_snapshot_provenance.py --output-format concise` — **All checks passed**.
- `git diff --check -- src/edge_platform/edge/storage.py src/edge_platform/scheduler/models.py src/edge_platform/scheduler/world_state.py src/edge_platform/scheduler/plan_evaluation.py src/edge_platform/scenario/closed_loop.py src/edge_platform/routes/replay.py src/edge_platform/tests/test_closed_loop.py src/edge_platform/tests/test_world_api.py src/edge_platform/tests/test_plan_evaluation.py src/edge_platform/tests/test_snapshot_provenance.py` — **passed**.

## Changed paths owned by this repair

- `src/edge_platform/edge/storage.py`
- `src/edge_platform/routes/replay.py` — preserved and regression-tested the Principal’s existing fix
- `src/edge_platform/scenario/closed_loop.py`
- `src/edge_platform/scheduler/models.py`
- `src/edge_platform/scheduler/plan_evaluation.py`
- `src/edge_platform/scheduler/world_state.py`
- `src/edge_platform/tests/test_closed_loop.py`
- `src/edge_platform/tests/test_plan_evaluation.py`
- `src/edge_platform/tests/test_snapshot_provenance.py`
- `src/edge_platform/tests/test_world_api.py`
- `.codex/artifacts/edge-review-repairs.md`

The worktree contains unrelated concurrent changes in other Edge, scheduler, database, NestJS, frontend, and documentation paths. Those changes were preserved and not included in this repair.

## Review result

- P1 station validation: fixed and covered.
- P2 snapshot provenance restart loss: fixed and covered.
- Replay missing-store double-write/dereference: regression added; existing Principal implementation verified.
- No unresolved scoped Edge defect found.
- No commits, remote actions, deployment, or production actions performed.
- next_entrypoint: Principal can consume this artifact during final integration review.
