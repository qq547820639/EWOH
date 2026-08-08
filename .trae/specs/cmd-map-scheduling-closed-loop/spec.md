# Command Map 智能调度闭环（Closed-Loop）Spec

## Why

指挥地图要把 Scheduling V2、World State、Routing、Reservation、SSE、人工审批真正连成一条统一、实时、可解释、可人工干预、可回放的生产调度闭环。当前存在局部双轨：`Scheduling/Scheduling.tsx` 仍走 legacy `SchedulePlan/generate/confirm`；地图与调度器缺少一个共享的 authoritative snapshot；缺 `runs` 列表、`conflicts`、`overrides`、策略版本化/影子策略等接口与能力。本变更在既有 `cmd-map-scheduling-cockpit`（已交付）基础上收敛剩余缺口，不新建平行调度系统。

代码审计结论（以真实仓库为准，与输入提示词差异处已标注）：
- PriorityEngine 的 `productionImpact` 与 `eventSeverity/deadlineAtRisk` **已接通**（前序改动），本变更不再重复实现，仅做一致性回归。
- Scheduler controller legacy `/plans*` 已带 `@deprecated` + `legacyCompatibility` 适配器；V2 端点齐全。
- 真实缺口：`GET /runs`、`GET /snapshot`、`POST /plans/:planId/overrides`、`GET /conflicts`、`GET /conflicts/:id`、策略版本化与 shadow 评估接口、`Scheduling/Scheduling.tsx` 迁移 V2、`SchedulingConflict` 统一类型。

## What Changes
- 新增 server authoritative 端点（复用 V2 内核，不另起命名空间）：
  - `GET /api/scheduler/runs`：run/plan 历史与活跃方案列表（分页、按状态/时间过滤）。
  - `GET /api/scheduler/snapshot`：返回地图与调度器共用的 authoritative operational state（含 freshness/dataQuality/entityVersion/reservations），收敛前端独立 availability 判断。
  - `POST /api/scheduler/plans/:planId/overrides`：把人工动作（Lock/Exclude/Boost/Preferred/Adjust）转成 `SchedulingConstraint` 并触发 replan，返回 before/after diff。
  - `GET /api/scheduler/conflicts`、`GET /api/scheduler/conflicts/:id`：统一 `SchedulingConflict` 列表与详情。
- `Scheduling/Scheduling.tsx` 迁移到 V2：`createRun` + `SchedulingPlanV2` + approve/reject/replan/dispatch；legacy 页逻辑剥离，legacy api 保留为兼容但不再被新页面依赖。
- 统一 `SchedulingConflict` 类型（shared/api.interface.ts），覆盖 double booking / resource stale / person unavailable / device offline / low battery / predecessor violation / station capacity / forbidden zone / safety block / blocked route / stale plan / reservation conflict。
- 事件驱动 replan 扩充触发源：TASK_CREATED / TASK_UPDATED / PERSON_UNAVAILABLE / DEVICE_OFFLINE / LOW_BATTERY / BOTTLENECK / DEADLINE_AT_RISK / SAFETY_EVENT / ZONE_RESTRICTED / route blocked/congested / reservation conflict；走 ImpactAnalyzer→局部 replan；保留 debounce/cooldown。
- 策略版本化与影子评估（只读/离线，不自动激活生产策略）：`GET /api/scheduler/policy`、`POST /api/scheduler/policy/versions`（候选）、compare/shadow 视图；feedback 仅用于离线评估与候选策略，需人工审批后才激活。
- 地图/资源池/调度器统一消费同一 authoritative state（`/snapshot` + SSE），禁止前端复制 backend 规则。

## Impact
- Affected specs: 调度正确性、实时同步、Command Map 驾驶舱 UI、人工干预、反馈闭环。
- Affected code:
  - server：`scheduler.controller.ts`、`scheduler.service.ts`、`plan.service.ts`、`world-state.service.ts`、`impact-analyzer.ts`、`replan-coordinator.service.ts`、`scheduling-policy.service.ts`、`scheduler-metrics.service.ts`、`dispatch-coordinator.service.ts`、`scheduler-stream.service.ts`、`resource-projection.service.ts`。
  - client：`api/scheduler.ts`、`Scheduling/Scheduling.tsx`、`CommandMap/CommandMap.tsx`、`panels/BrainPanel.tsx`、`panels/ResourcePoolPanel.tsx`、`panels/SchedulePanel.tsx`、`hooks/useSchedulerStream.ts`。
  - shared：`api.interface.ts`。
  - db：`scheduling_policy` 版本化字段（如无列则补）、conflict 表（如需要持久化历史冲突）。
- DB/API migration：新增 migration（policy version / 可选 conflict 表）；更新 OpenAPI route-manifest 与 route audit。

## ADDED Requirements

### Requirement: server authoritative run list
The system SHALL provide `GET /api/scheduler/runs` returning paginated run/plan history and active plans, sharing V2 types.

#### Scenario: Success case
- **WHEN** client calls `GET /api/scheduler/runs?status=active`
- **THEN** returns runs with plans, status, createdAt, pagination; client no longer relies on local useState as plan source of truth.

### Requirement: unified SchedulingConflict
The system SHALL expose unified `SchedulingConflict` with type, severity, scope, resolution recommendation, and read endpoints.

#### Scenario: Success case
- **WHEN** a DEVICE_OFFLINE or reservation conflict occurs
- **THEN** a `SchedulingConflict` is surfaced via `GET /api/scheduler/conflicts` and (where marked) triggers a scoped replan.

### Requirement: human override via constraints
The system SHALL convert all manual changes into `SchedulingConstraint` (+audit) and replan, never directly mutating a production assignment.

#### Scenario: Success case
- **WHEN** operator locks person/device/station/excludes/boosts via `POST /plans/:planId/overrides`
- **THEN** a `LOCKED_*`/`EXCLUDED_RESOURCE`/`MANUAL_BOOST` constraint is persisted (with operator/reason/validFrom/expiresAt/snapshotVersion), replan runs, and before/after diff is returned.

### Requirement: policy versioning + shadow evaluation
The system SHALL support versioned policy configs and read-only shadow evaluation; production policy changes require manual activation.

#### Scenario: Success case
- **WHEN** an operator registers a candidate policy version and runs shadow comparison
- **THEN** KPI/objective comparison is produced without altering the active policy; only explicit activation flips the production policyVersion.

## MODIFIED Requirements

### Requirement: Scheduling page migration to V2
`Scheduling/Scheduling.tsx` SHALL use `createRun` + `SchedulingPlanV2` + approve/reject/replan/dispatch instead of legacy `generatePlans/confirmPlan`/shadow·confirmed. Legacy api functions remain exported for compatibility but are no longer the new-page dependency.

### Requirement: event-driven replan scope
The replan trigger set SHALL be expanded (TASK_CREATED, BOTTLENECK, DEADLINE_AT_RISK, ZONE_RESTRICTED, …) while continuing to use ImpactAnalyzer→local replan, freeze unaffected/frozen assignments, and keep debounce/cooldown.

### Requirement: authoritative operational state
The map, ResourcePool, and Scheduler SHALL consume the same authoritative state (`GET /api/scheduler/snapshot` + SSE), with freshness/dataQuality/entityVersion/reservations; the frontend SHALL NOT maintain a separate availability rule set.