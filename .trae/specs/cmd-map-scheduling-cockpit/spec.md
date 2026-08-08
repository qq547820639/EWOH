# Command Map 智能调度驾驶舱升级 Spec

## Why
`ewoh-spark-app` 的 Scheduling V2 已具备完整闭环：动态优先级、Eligibility、路由成本、heuristic+CP-SAT+fallback、多目标评分、Plan/Assignment、WorldStateSnapshot、approve/reject/replan/compare/dispatch、SSE 后端（replaySince / Last-Event-ID / gap→RESYNC_NEEDED / polling fallback）、审计、outbox。但存在四个 P0 收敛缺口与三个 P1 补齐项，导致“地图=驾驶舱”仍未闭环：

1. **统一 Resource State 未闭环**：`ResourceProjectionService` 只投影 person/device/station，`reservations: []` 未水合、无 availability windows / current task / shift；tool/material/vehicle 无底层表（保持空）。
2. **ResourcePool 存在第二套调度**：`ResourcePoolPanel` 调用 gamification `allocateResources` 独立分配，绕过 Scheduler。
3. **Dispatch 未原子预占全部依赖资源**：`DispatchCoordinator` 只预占 person+device，不含 station/tool/vehicle。
4. **前端未接入 Scheduler SSE**：`client/src/api/scheduler.ts` 无 `useSchedulerStream()`；`SchedulePanel` 仅 `useState`，刷新/深链无法从服务端恢复 active plan。
5. **PriorityEngine 缺 ProductionImpact 因子**（base/deadline/waiting/severity/downstream/boost 已有，safety 走 hard constraint）。
6. **无 planned-vs-actual 反馈指标**：metrics 只有计数器，缺调度 KPI 闭环。

## What Changes
- 建立统一 `ResourceStateAggregator`（收敛进 `resource-projection.service.ts`），水合 reservation、availability windows、current task、shift、version、updatedAt、freshness；tool/material/vehicle 保持空但模型可扩展（无底层表，不伪造数据）。
- `ResourcePoolPanel` 迁移：任何人工资源操作 → `SchedulingConstraint`（LOCKED_* / EXCLUDED_RESOURCE / MANUAL_PRIORITY_BOOST / PREFERRED_RESOURCE）→ 调用 V2 replan；`allocateResources` 保留为兼容/gamification，标记 deprecated，不再作为正式调度写路径。
- `DispatchCoordinator` 扩展原子预占到 station（assignment 指定时含 tool/vehicle），事务内 preflight、任一失败整次回滚；增加 station reservation 的 DB 唯一约束防并发 double booking。
- 前端新增 `useSchedulerStream()`：连接 `GET /api/scheduler/v2/stream`，lastEventId、reconnect、gap→resync、polling fallback、更新 React Query cache；`SchedulePanel` 改用服务端权威 plan（getPlan/getRuns/active plans）+ 刷新/深链恢复。
- `PriorityEngine` 增加 `ProductionImpact` 因子（score/explanation 结构不变）。
- 新增 `SchedulingFeedback` 记录（planned vs actual / KPI），第一阶段仅离线评估与回归，不自动改生产规则。
- Command Map 增加候选资源（`GET /api/scheduler/tasks/:id/candidates`）、冲突、plan delta、执行偏差层；所有人工覆盖走 constraint+replan，记录 operator/reason/old/new/planId/snapshotVersion/policyVersion。

**不新增**：不新建平行 Scheduler、不重写 Eligibility/Priority/Route/Solver 核心、不伪造 tool/material/vehicle 数据、demo 数据与生产严格隔离。

## Impact
- 受影响 specs：Command Map UI、Scheduler 后端、ResourcePool、Dispatch、SSE、Policy、Metrics、数据库。
- 受影响代码：
  - 后端：`resource-projection.service.ts`、`resource-reservation.service.ts`、`dispatch-coordinator.service.ts`、`priority-engine.ts`、`scheduler-metrics.service.ts`、`scheduler.controller.ts`、`plan.service.ts`、`scheduler.service.ts`、`world-state.service.ts`、`shared/api.interface.ts`、`server/database/schema.ts`、migration。
  - 前端：`client/src/pages/CommandMap/panels/ResourcePoolPanel.tsx`、`SchedulePanel.tsx`、`CommandMap.tsx`、`client/src/api/scheduler.ts`、新增 `client/src/hooks/useSchedulerStream.ts`。

## MODIFIED Requirements
### Requirement: 统一 Resource State
系统 SHALL 由唯一 `ResourceStateAggregator` 提供 person/device/station 的权威状态，水合 reservations、availability windows、current task、shift、version、updatedAt、freshness。地图、ResourcePool、Scheduler、Dispatch 必须消费同一来源，禁止前端自行推导 availability。

#### Scenario: 资源视图与调度一致
- **WHEN** 某 person 已被 Dispatch 预占
- **THEN** 地图/ResourcePool 显示 busy/reserved，Scheduler 不再将其视为可任意复用。

### Requirement: ResourcePool 收敛到 Scheduler
ResourcePool 的人工分配 SHALL 转换为 `SchedulingConstraint` 并触发 V2 replan，不得直接写 Assignment。`allocateResources` 仅保留为兼容/gamification 并标记 deprecated。

#### Scenario: 拖拽锁定
- **WHEN** 用户把 P-001 拖到 TASK-001
- **THEN** 生成 `LOCKED_PERSON(TASK-001, P-001)` → replan → 展示新旧差异 → 影响分析 → 需 approve 后 dispatch，不直接改 task.assignee。

### Requirement: Dispatch 原子预占
Dispatch SHALL 在同一事务内 preflight + 原子预占 person/device/station（assignment 指定时含 tool/vehicle），任一失败整次回滚；station reservation 有 DB 唯一约束防并发 double booking，保留 plan CAS、idempotency、task lifecycle、outbox。

#### Scenario: 并发双 dispatch
- **WHEN** 两个 plan 并发 dispatch 抢占同一 station
- **THEN** 仅一个成功，另一个返回明确 `RESOURCE_CONFLICT`，DB 无重叠 reservation。

### Requirement: 前端 Scheduler SSE
前端 SHALL 通过 `useSchedulerStream()` 消费 `GET /api/scheduler/v2/stream`，支持 lastEventId、reconnect、gap→resync、polling fallback、React Query cache 更新，重复事件不重复执行业务操作。`SchedulePanel` SHALL 从服务端恢复 active plan（刷新/深链）。

#### Scenario: SSE 断线重连
- **WHEN** SSE 断开后恢复
- **THEN** 依据 lastEventId/sequence 增量恢复，缺口时全量 resync，最终地图状态与服务端一致。

### Requirement: Priority 含 ProductionImpact
PriorityEngine SHALL 在现有因子基础上增加 `ProductionImpact`，返回 `{ level, score, urgent, factors, explanation }` 结构不变；safety 走 hard constraint，不由 score 抵消。

### Requirement: 调度反馈指标
系统 SHALL 记录 planned vs actual（start/end/travel/wait/resource）与 replanCount/conflictCount/overrideCount/acceptanceRate/fallbackRate/solverRuntime，第一阶段仅离线评估、参数比较、回归测试，未经人工审核不自动修改生产调度规则。

## ADDED Requirements
### Requirement: 候选资源接口
系统 SHALL 提供 `GET /api/scheduler/tasks/:id/candidates`，返回 eligible 的 person/device/station、ETA/distance、skill match、workload/battery、reservation conflict、score、排除原因；前端只展示，不自行实现 Eligibility。

#### Scenario: 选中未派高优任务
- **WHEN** 用户选中一个未分派的高优先级任务
- **THEN** 地图高亮实时可用且满足硬约束的候选，并显示距离/ETA/匹配理由/排除理由。

## REMOVED Requirements
无（保留兼容，不废弃既有 API）。

## 兼容与安全
- 后端 API 保持兼容；须废弃处加 deprecated adapter。
- 不绕过 RBAC、审计、方案审批、snapshot freshness、plan version、task 状态机。
- 已执行/冻结/人工锁定 Assignment 不被自动重排覆盖。
- solver fallback 必须可见（OPTIMAL/FEASIBLE/HEURISTIC/FALLBACK/TIMEOUT/UNAVAILABLE）。
- 所有人工 override 可审计（operator/reason/timestamp/old/new/planId/snapshotVersion/policyVersion）。