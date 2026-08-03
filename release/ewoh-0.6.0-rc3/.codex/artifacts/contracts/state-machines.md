# State Machines (C3 v1.0)

Owner: AG-05
Status: C3 v1.0 frozen/validated (2026-08-03)
Source: `ewoh-spark-app/server/modules/{task,alert,model,scheduler,control,approval,resource,world-cursor,dashboard}/**`,
`ewoh-spark-app/server/modules/shared/state-machine.guard.ts`,
`test/unit/**`, `test/e2e/ewoh-http.e2e.spec.ts`,
`.codex/artifacts/work/reviews/persistence-tenancy-2026-08-03.md`,
`.codex/artifacts/work/evidence/round4.md`

## Enforcement Model

The dedicated `StateMachineGuard` exists and is unit-tested, but it is not
registered globally and no controller currently applies `@StateMachine`.
Service-layer guards are the contract:

1. Read the current row.
2. Compute the next status with the module transition function.
3. `UPDATE ... WHERE status = <current>` and require at least one affected row.
4. Zero affected rows means a concurrent transition won: HTTP 409
   `STATE_CONFLICT` (`ConflictException`).
5. A known action from an invalid source state is HTTP 400.

This is the concurrency authority for every state machine below unless noted.

## Task

Service: `server/modules/task/task.service.ts` (`nextTaskStatus`). Controller
roles: `global_admin`, `dispatcher`, `workshop_lead`. Every action is audited
with `task.<action>`.

| From | To | Action |
|------|----|--------|
| draft | pending_confirm | submit |
| pending_confirm | pending_approval | request_approval |
| pending_confirm | pending_dispatch | skip_approval |
| pending_approval | pending_dispatch | approve |
| pending_approval | draft | reject |
| pending_dispatch | dispatched | dispatch |
| dispatched | received | receive |
| received | executing | start |
| executing | paused | pause |
| paused | executing | resume |
| executing | exception | exception |
| exception | executing | resolve |
| executing | completed | complete |
| draft/pending_confirm/pending_approval/pending_dispatch/dispatched/received/executing/paused/exception | cancelled | cancel |

## Alert

Service: `server/modules/alert/alert.service.ts` (`nextAlertStatus`). Controller
roles: `global_admin`, `dispatcher`, `workshop_lead`, `safety_admin`. Every
transition is audited with `alert.<action>`.

| From | To | Action |
|------|----|--------|
| open, reopened | acknowledged | acknowledge |
| acknowledged, reopened | processing | process |
| processing | closed | close |
| closed | reopened | reopen |

## Model

Service: `server/modules/model/model.service.ts` (`nextModelStatus`). Controller
roles: `global_admin`, `device_ops`. Every transition is audited with
`model.<action>`.

| From | To | Action |
|------|----|--------|
| candidate | reviewing | submit_review |
| reviewing | shadow | approve_review |
| shadow, active | active | activate |
| active | retired | retire |

## Approval

HTTP module uses `ApprovalPersistenceService`; `ApprovalService` remains the
in-memory unit-smoke aggregate. Persistence maps an instance to
`ewoh_event(event_type='approval_instance')`, steps to
`ewoh_event_chain(causal_type='approval_step')`, and every action to
`ewoh_audit_log` (decision D-010: frozen 48-table DDL has no approval table).
Controller roles: `global_admin`, `workshop_lead`, `safety_admin`.

### Instance

| From | To | Condition |
|------|----|-----------|
| pending | approved | every step approved or skipped |
| pending | rejected | any step rejected |
| pending | expired | any step expired |
| pending | bypassed | high-privilege bypass; pending steps become skipped |
| pending | cancelled | initiator/operator cancel; approved/rejected/bypassed are terminal |

### Step

| From | To | Action |
|------|----|--------|
| pending | approved | approve |
| pending | rejected | reject |
| pending | delegated | delegate |
| pending | skipped | skip |
| pending | expired | expire |

Step and instance writes both use conditional updates; lost races return 409
`STATE_CONFLICT`. E2E proves instance, step, and audit rows persist with the
creating org id.

## Control Request

Service: `server/modules/control/control.service.ts`. Persisted to
`ewoh_control_request`, `ewoh_control_command`, `ewoh_control_result`.
Controller roles: `global_admin`, `dispatcher`.

| Request status | Rule |
|----------------|------|
| created | no attempts yet |
| pending_gateway | attempts exist, not all terminal |
| executed | latest attempt per command_key all executed |
| failed | latest attempt per command_key all failed |
| partial_success | latest attempts mix executed and failed |
| timeout | any latest attempt expired |

- One request maps to one device and multiple `command_key` values.
- Each retry inserts a new attempt with `root_command_id` + `attempt_no`.
- Aggregation reads only the latest attempt per logical command chain.
- `(org_id, idempotency_key)` unique index exists in DDL; the service returns
  the original request instead of duplicating, asserted by unit test and
  scenario SP-04, while E2E proves persistence and cross-org isolation.
- `revoke` is rejected once aggregate status is `executed`, `failed`, or
  `timeout`; otherwise pending/sent/gateway_received attempts become failed.

## Scheduler Plan

Service: `server/modules/scheduler/scheduler.service.ts`. Controller roles:
`global_admin`, `dispatcher`, `workshop_lead`.

| From | To | Action |
|------|----|--------|
| generated (shadow) | confirmed | confirmPlan |

Enforced: `confirmPlan` uses a conditional update inside one transaction and
409 on lost races, and writes `ewoh_schedule_audit` plus the audit chain in the
same transaction. Pending: the source state is read at runtime and no
allowed-source check exists, so re-confirming an already confirmed plan
succeeds; dispatch/expire/archive endpoints are not implemented; plan
generation is not idempotent; scheduler weights and weight history are
in-memory.

## Resource Preorder

Service: `server/modules/resource/resource.service.ts`. Persisted to
`ewoh_resource_preorder` and `ewoh_resource_binding`. Controller roles:
`global_admin`, `dispatcher`.

| From | To | Condition |
|------|----|-----------|
| pending | pending/issued | issue partial or full quantity; issued when fully issued |
| pending, issued | released | release remaining reservation |

Enforced: no-oversell reservation math and per-resource in-process lock.
Pending: inventory quantity is in-memory (no inventory table in frozen DDL);
issue/release updates do not use a `WHERE status` conditional guard, so the
lock is the only serialization authority.

## World Cursor

Service: `server/modules/world-cursor/world-cursor.service.ts`. Persisted to
`ewoh_world_snapshot` and `ewoh_world_delta_log`. Controller roles:
`global_admin`, `dispatcher`, `workshop_lead`.

- `GET /api/world/snapshot` materializes a new snapshot version and cursor.
- `GET /api/world/delta` pages upserts/removals after the cursor.
- A cursor from an older snapshot version returns 410 `CURSOR_EXPIRED`.
- E2E proves snapshot/delta persistence, cursor progression, and expiry.

## Dashboard Event Handling

Service: `server/modules/dashboard/dashboard.service.ts` (`handleEvent`).
Controller roles: `global_admin`, `dispatcher`, `safety_admin`, `device_ops`.

Current behavior: `status -> handled` unconditionally, records
`handlerAction`, `handlerNote`, `handler_operator`, and `handled_at` in
`evidenceJson`. Pending: no source-state guard (open/handled can both be
re-handled), no conditional update, and no audit-chain entry.

## Service-Enforced vs Pending

| Domain | Enforced today | Pending |
|--------|----------------|---------|
| task | transition function, conditional update, 409, audit | per-action role separation; controller role set only |
| alert | transition function, conditional update, 409, audit | SLA/escalation timers |
| model | transition function, conditional update, 409, audit | validation workflow artifacts |
| approval | conditional step/instance updates, 409, audit, org scoping | dedicated table; expiry scheduler |
| control | persistence, idempotency, latest-attempt aggregation | audit-chain writes; real gateway receipt validation |
| scheduler | conditional confirm + transaction + audit | full plan lifecycle, idempotent generation, persistent weights |
| resource | persistence, no-oversell lock | conditional status update, persistent inventory |
| world-cursor | persistence, 410 expiry | removal/upsert provenance, snapshot retention policy |
| event handle | handled status + evidence | transition semantics, conditional update, audit |

## HTTP Semantics

- Invalid action for current state: 400 with module message.
- Lost update / state race: 409 `STATE_CONFLICT`.
- `StateMachineGuard` (when applied later): 409 `STATE_NOT_ALLOWED`.
- Missing row: 404.

Evidence: `test/unit/{task,alert,model,scheduler,approval}/*.spec.ts` assert
409; `test/e2e/ewoh-http.e2e.spec.ts` asserts control org isolation,
idempotency persistence, world cursor expiry, and approval persistence;
`.codex/artifacts/work/evidence/round4.md` records 39 suites / 122 Jest tests
plus 10 HTTP+PostgreSQL E2E tests passing.
