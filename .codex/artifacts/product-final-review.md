# Product final review — 2026-09-10

Trace: EWOH-2026-09-10-product-delivery. Execution Agent ownership: `ewoh-spark-app/client/src/pages/FactoryOperations/` and its tests. Receipt UI is implemented; Principal browser verification remains.

## Execution receipt contract requested from backend owner

Keep the existing `POST /api/scheduler/executions/:assignmentId/update` and `updateExecution()` client function. The current backend repair adds a `receipt` envelope and derives `real/simulated/unknown`, but `ExecutionUpdateRequest` still has no declared source field. Add `reportedSource?: 'manual_report' | 'simulated'` (or an equivalently named persisted field) to the request, persist it, and expose it alongside the derived `receipt.source` on `ExecutionReceiptResult`. This preserves what the operator actually selected; `receipt.source` alone may collapse a manual report into a derived category. Neither option establishes verified real equipment evidence or production training eligibility.

- Start: `{ status: 'STARTED', actualStartAt: <explicit-click ISO time>, source, triggerReplan: false }`.
- Complete: `{ status: 'COMPLETED', actualEndAt: <explicit-click ISO time>, source, triggerReplan: false }`; UI requires an existing actual start and does not invent it from planned times.
- Fail: `{ status: 'FAILED', actualEndAt: <explicit-click ISO time>, deviationType: 'MANUAL_OVERRIDE', deviationReason: <required operator explanation>, source, triggerReplan: false }`.
- Preserve the return type `SchedulingExecution` plus the current `receipt` envelope. Only return success after execution, assignment/task and feedback have reconciled. If partial completion is possible, return explicit recoverable failure information; an ordinary 2xx record cannot be represented as a fully synchronized receipt otherwise.
- Preserve stable actual timestamps on repeated identical receipts; reject terminal rewrites, invalid transitions and competing updates. Authorization/tenant ownership remain server enforced. Current `SchedulerController` roles are `global_admin`, `dispatcher`, `workshop_lead`; frontend will match them.
- The frontend does not submit verified-real/training-eligible flags, measurements, durations, travel or waiting values that the operator has not observed.

## Truth fixes already implemented

Per-endpoint dated fetch times replace the misleading maximum timestamp; expired times and failed refetches remain visible. KPI unknowns render as neutral dashes, including missing worker count. Empty attention requires both event and plan data to be present and current and explicitly limits the claim to loaded records. Plan loading and errors have their own messages and retry action. Plan cards preserve plan IDs, include approved/dispatched/executing states, reserve list space for decisions, and distinguish predicted metrics from execution facts. The home page now consumes the shared scheduler active-plan cache. Safety-role shortcuts respect existing route authorization.

Initial validation: targeted client Jest run passed 6 suites / 47 tests; `npm run type:check:client` and focused ESLint passed before receipt UI work. No full Node suite, database mutation or browser run by this agent. Principal owns final browser verification and updated login-landing expectations.

## Receipt UI implemented

`FactoryOperations/ExecutionFeedback.tsx` reads the existing `GET /api/scheduler/executions` context and uses `POST /api/scheduler/executions/:assignmentId/update`. For PLANNED/DISPATCHED/PAUSED rows it exposes start; for STARTED rows it exposes complete or failure with a required explanation. The operator selects `simulated` or `manual_report`; each request uses the click-time ISO timestamp, never a planned time. Terminal rows are read-only. Scheduler roles are enforced in the UI and the API remains the authority. Success invalidates the plan-scoped execution cache; API failures show parsed guidance. The backend must declare, persist and return the reported source as described above, and unify execution, assignment/task and feedback persistence before this is described as a complete receipt.

Receipt request and transition guard tests cover all three transitions, provenance, failure reason, explicit timestamps, stale reads, unauthorized roles, terminal records, and the absence of invented start times. `CandidateRejectReason.device_data_unavailable` is rendered as `设备数据不可用` in candidate explanations and `设备电量数据不可用` in conflict center metadata; the conflict icon map is complete. Nullable `WorldStateSnapshot` battery values pass client type checking.

## Actual core flow paths

1. FactoryOperations fetches dashboard overview, the recent 24-hour event page, and the org-scoped scheduler active plans. An event opens `/o/alert/:eventId` for evidence/device context. A plan opens `/o/scheduling_plan/:planId`, where the existing plan journey exposes review, approval, dispatch, execution and history routes.
2. Scheduling creates a NestJS authoritative plan. Simulation remains an explicitly separate read/write evaluation path. Draft plans require approval; shadow plans remain non-approvable and non-dispatchable by backend guard.
3. Approved plans dispatch through `POST /api/scheduler/plans/:planId/dispatch`, with server freshness, safety and reservation checks. Dispatch creates planned execution rows, with `executionSync` warning when execution record creation cannot be completed.
4. FactoryOperations `ExecutionFeedback` reads `GET /api/scheduler/executions`, supports `?plan=<planId>`, and shows start/complete/failure actions only for scheduler roles. Actions call the existing update endpoint with click-time actual timestamps, selected simulated/manual source, and no unobserved measurements. A returned receipt displays matched feedback, assignment/task advancement, skips, source and server training eligibility. Missing receipt data is stated as unconfirmed.
5. On errors, the read panel shows stale/failed state and pauses writes; mutation errors expose parsed guidance/request identity and allow retrying the exact saved request. Terminal execution rows are read-only. Browser auth/landing and full database reconciliation remain Principal/backend-agent verification.

Validation after the receipt and mapping changes: `npm run type:check:client` passed; focused ESLint passed; focused Jest passed 4 suites / 29 tests. No full Node suite, database mutation or browser run by this agent.

## Broader ownership findings for Principal

- P1 cache invalidation mismatch: `client/src/pages/CommandMap/hooks/schedulerRealtimeCore.ts:41` still returns literal `['scheduler', 'snapshot']` and `['scheduler', 'conflicts', {}]`, which cannot invalidate the newly scoped `['scheduler', orgId, ...]` queries. `PlanComparePanel.tsx:78` still consumes unscoped `['scheduler-active-plans']`. These require the cache/map owner to update and test alongside the changed query keys.
- P2 result links: `Scheduling/planActions.ts` links execution to `/work-orchestration?plan=...` and history to `/decision-history?plan=...`, but neither target consumes `plan`. WorkOrchestration reads generic work graph/overview, not scheduler executions, and its route is global-admin-only. The real existing scheduler readback is `CommandMap/panels/ExecutionDeviationList.tsx`, mounted for the selected plan by `SchedulePanel.tsx:731`. Receipt work will add a plan-scoped read/write context on FactoryOperations; existing cross-page links still need routing ownership coordination.
- P2 anomaly handoff: alert detail has evidence and device links, but no event-to-impact-to-plan action carrying the event identifier. Scheduling currently generates a MANUAL trigger. SimulationConsole also does not accept a plan deep link. Do not claim one carried context across these pages.
- P2 root route: `/` unconditionally redirects to `/factory-operations`, which denies worker/device_ops even though `defaultLandingPath` has role-specific destinations. Principal owns app/navigation changes.
- Provenance contract: dashboard overview provides no source mix, source timestamps or sample counts; dashboard event mapping drops optional source/evidence fields. UI now discloses this instead of inferring real/live data. Backend owner should expose these fields to support stronger claims.

## Current scope limits

Review uses current React/Nest code. `ui/command_map/` is archived and untouched. No commits, remote changes, deployment or real equipment commands. Backend execution unification and sample provenance are owned by the backend agent; their completion must be verified independently.

## Client integration closure

The root authenticated route now uses `defaultLandingPath(getAuthUser()?.roles)`, so workers and device operators land on the mobile workbench while management and dispatch roles land on FactoryOperations. Scheduler realtime polling/resync keys now come from the org-scoped `queryKeys` for active plans, snapshot, resources, and conflicts; PlanComparePanel uses the same active-plan key. Plan execution links now target `/factory-operations?plan=...`, which consumes the plan filter and receipt context. Decision-history actions now link to the real unfiltered history page without implying unsupported plan filtering. No backend files were changed for this closure.

Closure validation: client typecheck passed; focused ESLint passed; the final focused Jest run passed 10 suites / 143 tests, including navigation, cache, realtime, plan actions, receipt, FactoryOperations, conflict, and candidate mappings. Principal still owns authenticated browser verification and PostgreSQL workflow verification.
