# E2E final repair handoff

## Scope

Execution Agent ownership covers the existing `ewoh-spark-app/test/e2e/*.spec.ts` suites and `ewoh-spark-app/test/helpers/e2e-db.ts`. The Principal retains ownership of the new `factory-closed-loop.e2e.spec.ts`. No application behavior or production security was changed, and no commit was created.

## Principal handoff

`test/helpers/e2e-db.ts` now exports:

```ts
export interface SchedulerFixture {
  taskId: string;
  personId: string;
  deviceIds: [string, string];
  stationId: string;
}

seedSchedulerFixture(owner, orgId): Promise<SchedulerFixture>
```

The seed creates one available worker and one person spatial entity at known factory coordinates `(10, 20)`, one active workstation at `(10, 20)`, two fresh `source_type = 'simulated'` exoskeleton devices with the shared `lifting_assist` capability, and one pending simulated production task requiring `lifting` and `lifting_assist`. The task is assigned to the workstation and has a future scheduling window. Device IDs are unique per invocation and are returned as a tuple.

`createE2EFixture` now also returns `approverA`, a distinct same-org non-global `workshop_lead` user. Use `dispatcherA` to create/dispatch and `approverA` to approve. The repository has no registered `supervisor` role; `workshop_lead` is an allowed scheduler approver role.

## Cleanup repair

`cleanupE2EFixture` uses a static known table whitelist, intersects it with the actual public schema's `org_id` columns, and deletes with `org_id::text = any($1::text[])`. This handles varchar scheduler tables and uuid domain tables without unsafe uuid casts, while avoiding dynamic table names from uncontrolled input. It also covers receipt, scheduler run/plan, reservation, replan, route and world-state tables present in the current schema.

## Verification state

- `git diff --check`: passed.
- `npx tsc --noEmit --project tsconfig.node.json` passes at the current workspace. A transient receipt-agent edit had introduced `duration-model-training.service.ts:90-94` (`r` undefined, TS2304), and was subsequently corrected. The E2E/helper edits introduce no TypeScript error.
- Real PostgreSQL focused results with owner/runtime credentials and `--runInBand`:
  - `org-rls-guc.e2e.spec.ts`: **PASS 2/2**.
  - `snapshot-concurrency.e2e.spec.ts`: **PASS 1/1** after correcting the array SQL.
  - `concurrency-real-pg.e2e.spec.ts`: the original run showed **PASS 4/4**, but J3/J4 used debounce/no-plan conditional returns and was not accepted as coverage. The strict rewrite is now part of the final full run: **J1 PASS, J2 PASS, J3 FAIL (201 + 500 concurrent replan; 500 is not accepted), J4 FAIL (500 INTERNAL_ERROR, transaction aborted while attempting unavailable-worker fallback)**. J2 now inserts two org-scoped runtime transactions and verifies exactly one success plus one PostgreSQL `23P01` exclusion violation. J3/J4 have no conditional skip branch.
  - `replan-dual-instance.e2e.spec.ts`: **PASS 2/2** (D1 and D2). The final audit query uses the owner connection; runtime requests remain scoped.
  - `scheduler-upgrade.e2e.spec.ts`: A-E and G-I passed; F failed with the actual HTTP response `409 {error:{code:"CONFLICT", message:"RESOURCE_CONFLICT"...}}` on dispatch of a fresh seeded plan. This remains an unresolved fixture/resource conflict and is not treated as a pass.
- Final full command, with the supplied owner/runtime PostgreSQL URLs, was `npm run test:e2e -- --runInBand`. It completed in 48.634s with **8 suites: 4 failed, 4 passed; 58 tests: 16 failed, 42 passed**. No application file was modified by this execution agent and no commit was created.

The first full run completed with **8 suites: 4 failed, 4 passed; 58 tests: 15 failed, 43 passed**. The failed suites/tests were:

- `f61-02-persistence.e2e.spec.ts`: 3 failures (resource listing, restart handoff state shape, idempotent replay); 3 tests passed.
- `scheduler-upgrade.e2e.spec.ts`: all 9 tests passed in the final run after fresh F seeding. C and D still log explicit legacy skips for missing route graph/locked assignment facts inside their test bodies; those are not counted as coverage of those sub-scenarios.
- `concurrency-real-pg.e2e.spec.ts`: final full run had J1/J2 pass and J3/J4 fail with the strict results above.
- `ewoh-http.e2e.spec.ts`: 10 failures (health detail shape, workflow permission, refresh rotation, snapshot versioning, exoskeleton ingest 503, OEE null, support bundle 400, approval create 400, scheduler idempotency 401, feature flag status 200 vs expected 201).
- `pg-temporary-failure.e2e.spec.ts`: fault injection caused `TypeError: Cannot read properties of null (reading 'write')` in the postgres driver; the strict app-scoped attempt still reproduces this driver failure. The full run did not leave a terminating Jest process after the final cleanup check.

The full run also showed a persistent `RequestDatabaseContext NEST-504` warning during login/readiness. It did not fail the passing RLS, snapshot, or replan suites. The final type check and `git diff --check` passed. The test app now scopes fault injection with a unique PostgreSQL `application_name`; no test app process remained after the final cleanup check.

## Known follow-up

The focused scheduler/concurrency suites owned here now use scoped fixture users and no `created_by = NULL` approval bypass. The helper and fixture contract are ready for the Principal's closed-loop scenario immediately. The remaining explicit conditional paths in older suites are recorded for the next focused pass; core closed-loop coverage must not depend on them.

## Current blocking evidence

An earlier Jest invocation was blocked at ts-jest compilation by a backend file outside this ownership boundary:

```text
server/modules/scheduler/prediction/duration-model-training.service.ts:90:26
TS2304: Cannot find name 'r'.
```

This was sent to Principal `01a08889-b034-7161-bb1c-c6002b19e626` and receipt agent `01a08991-3716-7c31-9908-5808a11dc712`; it is now fixed. The persistent `RequestDatabaseContext NEST-504` login warning is observable during E2E but was not a test failure in the passing suites.
