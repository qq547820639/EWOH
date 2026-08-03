# Requirements Trace (v1.0)

Owner: AG-01 / AG-41
Status: v1.0 validated against current implementation (2026-08-03)
Source: authoritative-plan Final 3.0 + Final 1.0,
`.codex/artifacts/work/reviews/*2026-08-03.md`,
`.codex/artifacts/work/evidence/round4.md`, `test/**`, `ewoh-spark-app/**`,
`src/edge_platform/**`

Rule: an existing page, route, or module is evidence of implementation, not of
capability completion. Each row lists current evidence, missing items, and the
condition that closes the capability.

| Center | Current evidence | Missing / partial | Next-stage completion condition |
|--------|------------------|-------------------|--------------------------------|
| 1. Command center | `CommandCenter.tsx` renders real overview + events; `dashboard.service.ts` aggregates devices/events/load/workers; Playwright render evidence (`.playwright-cli`) | KPI page is single-shot fetch; 3D thumbnail and alert/task deep links are not implemented; no per-role KPI variants | Poll or refresh KPI data, add alert/task drill-down from CommandCenter, verify with Playwright scenario |
| 2. Digital world | `DigitalWorld.tsx` calls hierarchy/world state; `world.service.ts` aggregates persons/devices/workstations/events; L0-L4 + 9 modes + real replay in CommandMap; world cursor snapshot/delta persisted (E2E) | DigitalWorld tree has no explicit empty state; L3/L4 relation lists are global slices; snapshot/delta cursor is separate from CommandMap replay ingestion | Filter L3/L4 relations by focused entity, wire replay to world-cursor deltas, add tree empty state, SP-05 HTTP+DB replay test |
| 3. Scheduling | `scheduler.service.ts` generates plans, `confirmPlan` is transactional + conditional 409 + audit; `Scheduling.tsx` lists plans; scheduler module used by CommandMap panels | Only confirm is implemented; no dispatch/expire/archive, no plan generation idempotency, weights/weight history in-memory, Scheduling page is read-only | Full plan lifecycle endpoints with conditional updates, persistent weights, idempotent generation, SP-02 HTTP+DB scheduling flow |
| 4. AI decision | `ai.service.ts` manual suggestions/plans, `AiDecision.tsx` calls create suggestion/plan, controller roles dispatcher/global_admin | Snapshot freeze semantics, approval flow binding, and pre-generation guard are not implemented as an audited chain | Bind AI plan output to schedule plan approval flow, freeze input snapshot, add HTTP+DB SP-03 test |
| 5. Devices | `dashboard.service.ts` 19-dimension search params, device list/detail/create/patch/bindings; `Devices.tsx` search + config drawer; `/api/devices` DeviceContractController routes exist | `/api/devices` controller default-denies all roles (no role metadata/fallback); binding history UI and 12 config-class panels incomplete; battery unknown shows misleading 0% | Declare roles for DeviceContractController, complete config panels and binding history, verify viewer-403 and device_ops flows |
| 6. Personnel/exo | `organization.service.ts` personnel list/detail + `coarseHealthRisk`; sensitive route gated to safety_admin/global_admin; `Personnel.tsx` debounced search; binding endpoints exist | Exo exclusivity matrix, full load/fatigue privacy model, and org-scope service filtering are not implemented | Enforce exo-person exclusivity and sensitive-detail audit, add SP-01 HTTP+DB scenario |
| 7. Risk/alerts | `alert.service.ts` open/acknowledged/processing/closed/reopened with conditional 409 + audit; `Alerts.tsx` transition UI; CommandMap EventCenter acknowledge/handle; rule engine generates events | No SLA timers, no escalation state, dashboard `handleEvent` is unguarded and un-audited, rule-engine dedup is process-local | Add SLA/escalation states, guard + audit event handling, persist dedup, SP-01/SP-07 integration coverage |
| 8. Organization/space | `organization.service.ts` org/personnel CRUD + audit; `spatial.service.ts` entities/topology/hierarchy; org tree UI | `OrgScopeService` hierarchy resolution unused; app-layer org filters absent (RLS-only); personnel `org_id` varchar vs uuid migration gap documented | Wire descendant org resolution into AccessTokenGuard and add app-layer org filters, SP-06 real multi-org test |
| 9. Model management | `model.service.ts` candidate/reviewing/shadow/active/retired with conditional 409 + audit; `ModelManagement.tsx` list/transition UI | No validation workflow artifacts, model asset/binding tables not used by service, no publish/version snapshots | Implement model asset/binding lifecycle and validation workflow, SP-03 related model scenario |
| 10. Data assets | `DataAssets.tsx` lists model registry + system config counts; models and config APIs work | No data-source/credential tables, no AES-GCM credential vault, no lineage/health/quality API; page is summary-only | Add data source registry, credential vault, health/quality/lineage APIs, SP-07 integration test |
| 11. System | `System.tsx` config list; `/api/system/config` masked values, global_admin gated, `(org_id, config_key)` upsert; audit read safety_admin/global_admin; auth/refresh/logout; rate limit; RolesGuard default deny | No notification center, no user/role management UI, no automated audit-chain verification job, no three-level stop controls, safety_admin system nav/API mismatch | Add notifications, user/role management, automated audit verification, three-level stop as audited controls, align UI/API roles |

## Scenario Packages

| Scenario | Current classification | Evidence |
|----------|------------------------|----------|
| SP-01 person/exo safety | unit smoke + personnel route | `test/scenarios/scenario-packages.spec.ts` pure functions; organization personnel route |
| SP-02 task scheduling | unit smoke; HTTP plan confirm not covered | in-memory service tests |
| SP-03 AI decision | unit smoke | in-memory AiService |
| SP-04 device control | unit smoke + HTTP control persistence/isolation | control service + E2E |
| SP-05 digital world replay | unit smoke + HTTP world cursor | world-cursor service + E2E |
| SP-06 multi-org isolation | unit smoke + HTTP control/config isolation | E2E org A/B |
| SP-07 data source/audit | unit smoke + HTTP audit persistence for approval | approval persistence E2E |
| SP-08 release/rollback | DDL plan + real PostgreSQL rollback/rebuild | `standalone-postgres-check.sh`, round 3/4 |

Each scenario becomes a completion unit only when it runs as an HTTP +
PostgreSQL integration test that asserts state, persistence, and org boundary.
The current E2E suite covers a subset of these claims; the rest remain
next-stage work.
