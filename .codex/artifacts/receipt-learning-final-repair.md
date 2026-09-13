# Receipt / feedback / duration learning repair

Date: 2026-09-10
Owner: Execution Agent
Scope: `ewoh-spark-app/server/modules/scheduler` receipt and feedback services, scheduler receipt contracts, OpenAPI generated types and focused unit characterization tests.

## Delivered

- `SchedulingFeedbackService.recordActuals` is now a canonical-only adapter. It delegates to `ExecutionReceiptApplicationService` and throws `ServiceUnavailableException` before any database write when the canonical dependency is absent. The removed implementation no longer contains broad OR matching, direct feedback-only actual writes, best-effort state advancement, swallowed advancement errors, or a second assignment-event path.
- `SchedulerEventApplicationService.recordTaskActuals` and `SchedulerDispatchApplicationService.executionUpdate` use the canonical receipt application. The facade/SSE characterization fixtures inject that application service and assert that the facade does not emit a duplicate execution outbox event.
- Canonical application keeps the org + supplied key predicates conjunctive, locks plan/task/assignment/execution/feedback in a stable order, uses assignment CAS/version advancement, rejects immutable fact conflicts and terminal regressions, and lets execution/task/feedback/assignment/outbox failures abort the request transaction.
- Receipt provenance is persisted on feedback. `manual_report`, `simulated`, shadow/non-production persisted markers and prior non-production provenance cannot become real later. Omitted `reportedSource` is not treated as real.
- Real training eligibility requires an independently persisted device receipt with `source=device_receipt`, completed execution facts, matching org/plan/task/assignment/device/execution identifiers and matching persisted timestamps. Task/device `sourceType=real`, plan approval, or current HTTP timestamps alone are insufficient. Approval evidence also requires a persisted plan creator and a different persisted confirmer with a confirmation time.
- OpenAPI was regenerated with `npm run gen:openapi`; `client/src/types/openapi.d.ts` and `client/src/types/work-orchestration.d.ts` are synchronized. The parity fixture includes `reportedSource` and the execution `note` compatibility field.

## Verification

Passed:

- `npm run type:check` (server and client)
- `npm run gen:openapi`
- `npm run gen:openapi:check`
- Focused receipt/facade/SSE suite: 4 suites, 80 tests passed:
  - `server/modules/scheduler/__tests__/scheduler-facade-characterization.spec.ts`
  - `server/modules/scheduler/__tests__/scheduler-sse-events.spec.ts`
  - `server/modules/scheduler/__tests__/scheduling-feedback.spec.ts`
  - `server/modules/scheduler/__tests__/openapi-type-parity.spec.ts`
- `server/modules/scheduler/__tests__/execution.service.spec.ts`
- `server/modules/scheduler/prediction/__tests__/duration-model-training.service.spec.ts`
- Final focused rerun after training revalidation: 9 suites, 117 tests passed, including the migrated legacy receipt suites: `execution-feedback-advancement.spec.ts`, `r2-ssv-regression.spec.ts`, and `golden-scheduler-workflow.spec.ts`.

The three legacy receipt suites now use the stateful canonical receipt harness. The harness evaluates real Drizzle predicates, enforces transaction-scoped access, serializes transactions, snapshots and rolls back state on failure, and exercises real execution/task/canonical application services. No legacy fallback was restored.

No database migration, E2E file, client page, resource projection, eligibility implementation, or shared scheduler resource type was edited in this pass. Migration 070 remains owned by the migration/principal chain and was not rerun here.
