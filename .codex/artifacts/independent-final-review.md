# Independent final review

## review_status

`reviewed_with_findings`

This is a read-only review of the current uncommitted worktree. The product target is a runnable React/Nest/Postgres product; Edge is simulated integration evidence only. I did not edit implementation files, the canonical receipt implementation, the Edge interruption disposition, or the local runnable-service work. The user-reported `replay.py` `ws=None` defect is acknowledged and excluded from the independent count because it already has an owner. The schema-generator verify-list issue is likewise excluded because it is delegated to Gibbs. The factory closed-loop test is excluded because it is owned by the user.

Current-tree checks run for this review:

- `PYTHONPATH=src python3 -m unittest src.edge_platform.tests.test_closed_loop src.edge_platform.tests.test_scenario src.edge_platform.tests.test_repository -v` — 44 passed.
- `npm run test:client -- src/hooks/queryKeys.test.ts src/lib/navigation.ia.test.ts src/lib/runtimeLifecycle.test.ts` — 3 suites, 25 passed.
- `npm test -- --runInBand test/unit/scripts/standalone-chain.spec.ts test/unit/scripts/standalone-ddl.spec.ts` — 2 suites, 8 passed.
- `npm run type:check:client` — passed.
- `git diff --check` — not clean: it reports a pre-existing trailing blank line at EOF in the current changed file `ewoh-spark-app/server/modules/scheduler/__tests__/r2-ssv-regression.spec.ts:357`; this review did not edit that file.

These results are current-worktree checks only; they do not establish that historical tests or the complete product stack pass.

## anchor_alignment

The work is aligned with the requested scenario/lifecycle evidence, tenant-aware product routing, and migration-chain/generator semantics. The migration chain and focused generator checks were coherent in the reviewed paths, including the explicit dependency that keeps migration 017 ahead of 008. The principal risk is that the UI's tenant selector, authenticated server tenant, query cache, and API routing do not share one authority. That blocks a tenant-safe product delivery even though individual query-key tests pass.

## severity_counts

```yaml
P0: 0
P1: 3
P2: 1
P3: 0
```

## defects

### P1 — Visible tenant selector does not route requests or cache scope to the selected tenant

Anchors:

- `/Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/components/app-shell/ContextBar.tsx:17-24`
- `/Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/components/app-shell/OrgEnvSwitcher.tsx:48-64`
- `/Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/lib/appContext.ts:89-102`
- `/Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/hooks/queryKeys.ts:19-32`
- `/Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/lib/http.ts:39-48`

`OrgEnvSwitcher` changes `AppContext.orgId`; `ContextBar.update()` persists it in `localStorage` and disposes runtime resources. It does not change the authenticated user in `sessionStorage`, obtain a server-authorized tenant switch, or add the selected org to the request. `currentOrgScope()` reads only `sessionStorage['ewoh_auth_user'].orgId`, while `axiosForBackend()` attaches only the bearer token. Consequently, selecting `org-2` can leave the visible shell on tenant B while query keys and server calls remain on the login tenant A. Since the server's scheduler/spatial/quality paths derive tenant context from `request.userContext.primaryOrgId`, a client-side local selector cannot alter the authoritative server tenant.

Repro reasoning: log in as a user whose authenticated `orgId` is `org-1`; choose `org-2` in the persistent context bar; inspect a subsequent `/api/dashboard/*` or `/api/scheduler/*` request and `queryKeys.worldState`. The request still carries the same bearer identity and no selected-org header/route, while the UI renders `org-2`; the key still scopes to `org-1`. This is a routing/authority split and can present data under the wrong visible tenant.

Action: make the selector perform a real authorized tenant switch and update the authoritative session/query scope, or remove its implication that it switches tenant. Route all tenant-owned requests from the same verified context and add a regression test asserting selector change updates both request routing and key scope.

### P1 — Tenant-owned query data remains globally keyed and survives logout

Anchors:

- `/Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/hooks/queryKeys.ts:68-70`
- `/Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/hooks/queryKeys.ts:119-175`
- `/Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/lib/AppContainer.tsx:9-24`
- `/Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/lib/auth.ts:176-186`
- `/Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/lib/auth.ts:188-200`

The change scopes several world/scheduler keys, but `events`, `devices`, `deviceBindings`, `commandCenter`, `digitalWorld`, `personnel`, `alerts`, `organizationTree`, `organizations`, models/assets/configuration, mobile/work/operations/scale keys, `simulationRuns`, and `decisions` remain unscoped. The concrete consumers include `useCommandMapQueries.ts:85-110`, `Devices.tsx:76`, `Personnel.tsx:64-84`, `Operations.tsx:187-243`, `Scale.tsx:80-201`, and `WorkGraphPanel.tsx:296-313`. `AppContainer` keeps one `QueryClient` for the app lifetime, and `revokeSession()` clears credentials and runtime resources but never clears or namespaces its cached data.

Repro reasoning: log in as tenant A and load devices/events/personnel/operations; call logout; log in as tenant B in the same app instance; mount one of those pages. React Query can serve the old unscoped successful result immediately, and invalidation/refetch timing determines when it is replaced. A tenant switch also leaves these keys identical because their key factories omit the org. This is a cross-account data disclosure risk and can also cause writes or optimistic updates to be displayed against the wrong tenant.

Action: put the authoritative tenant in every tenant-owned key, including derived/detail keys and invalidation keys, and clear or replace the QueryClient on logout and tenant transition. Add a test that seeds tenant A, logs in as tenant B, and proves no tenant A result is returned before B's fetch completes.

### P1 — Deterministic Edge evaluation accepts an assignment with an unknown station

Anchors:

- `/Volumes/Extra/CodeProj/EWOH/src/edge_platform/scheduler/plan_evaluation.py:16-64`
- `/Volumes/Extra/CodeProj/EWOH/src/edge_platform/scheduler/scheduler_service.py:483-503`

The evaluator indexes tasks, persons, and devices, checks those resources and routes, and uses `station_id` only as a conflict key. It never verifies that the station exists in `snapshot.stations`, nor that it is available or has capacity. The simulated lifecycle uses `evaluation['feasible']` to move `shadow -> simulating -> pending_review`.

Repro executed against the current tree:

```python
snapshot = WorldStateSnapshot(
    snapshot_id='s', timestamp='2026-09-10T00:00:00Z',
    persons=[{'person_id': 'p', 'active': True}], devices=[],
    tasks=[{'task_id': 't', 'status': 'pending'}],
    stations=[{'station_id': 'known'}],
)
assignment = CandidateAssignment(
    task_id='t', person_id='p', device_id='', station_id='MISSING',
    route={'reachable': True}, planned_start='2026-09-10T08:00:00Z',
    planned_end='2026-09-10T09:00:00Z',
)
evaluate_plan(SchedulePlan(plan_id='p', assignments=[assignment]), snapshot, ['t'])
```

Observed: `feasible == True`, `blockers == []`. In this product Edge is simulation-only and does not authorize dispatch, so this is a lifecycle/evidence truth defect rather than a production execution authority defect. Action: validate station existence and availability/capacity and emit explicit `STATION_MISSING`, `STATION_UNAVAILABLE`, and capacity blockers; add the negative regression case before treating the Edge evidence as lifecycle-complete.

### P2 — Persisted Edge snapshots lose source timestamp provenance after restart

Anchors:

- `/Volumes/Extra/CodeProj/EWOH/src/edge_platform/scheduler/world_state.py:88-116`
- `/Volumes/Extra/CodeProj/EWOH/src/edge_platform/scheduler/scheduler_service.py:601-608`
- `/Volumes/Extra/CodeProj/EWOH/src/edge_platform/edge/storage.py:1333-1355`
- `/Volumes/Extra/CodeProj/EWOH/src/edge_platform/edge/storage.py:1358-1380`

`WorldStateService.build_snapshot()` attaches `source_timestamps` to the in-memory snapshot. `save_world_state_snapshot()` persists the entity arrays, events, and topology version but no source timestamp map. After restart, `_reference_snapshot()` hydrates from the stored row and `evaluate_plan()` returns `source_timestamps: {}` even when the original snapshot contained source timing data. The simulated evaluation remains usable, but its persisted evidence is less traceable and no longer carries the provenance advertised by the evaluator output.

Action: persist the source timestamp map in a versioned metadata JSON column/field and add a restart hydrate/evaluate regression test.

## repeated_error_patterns

- Tenant context is duplicated across authenticated session storage, local app context, query-key factories, and server request context without one authoritative transition protocol.
- Lifecycle cleanup closes sockets, SSE, timers, and related resources, but does not clear the React Query data plane that can outlive those resources.
- Simulated plan evaluation validates only part of the candidate resource graph: task/person/device checks exist, while station existence and availability do not.
- Schema authority is split across legacy DDL generation, standalone-chain registration, specialized verify mappings, and receipt migration additions. The focused chain/DDL checks were coherent, but future changes need one explicit source-of-truth check to prevent drift.

## plan_challenge

The current plan can credibly demonstrate Edge simulation mechanics and migration/generator mechanics, but it cannot claim tenant-safe product behavior while the selector and authenticated tenant disagree and global cache keys survive account changes. Correct tenant authority and cache isolation before treating React product delivery as complete. Add evaluator negative tests before calling the Edge closed loop lifecycle-complete. Keep the canonical receipt server implementation owned by agent01a08991; this review found no need to duplicate it.

## final_recommendation

`hold` for overall product delivery until the tenant authority/routing mismatch and cross-account cache isolation are corrected, followed by current PostgreSQL and browser verification on the resulting tree. `conditional_pass` for the reviewed Edge simulation and migration-chain mechanics, subject to the station validation and provenance follow-ups. No independent P0 was found. The user-owned replay defect, Gibbs-owned generator verify-list issue, and user-owned factory closed-loop test remain outside these counts.
