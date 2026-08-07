# Command Map 智能调度闭环 Spec（Python 后端 + ui/command_map）

## Why
当前「指挥地图 / Command Map」停留在「地图展示 + 单任务人员推荐 + 人工确认」：
- `services.recommend()` 只做单任务人员排名，「区域距离」用 `team/zone` 字符串相同近似，非真实路径。
- 前端 `app.js` 用 `CM.SAMPLE_DATA.plans` 展示方案；`scenario-panel` 确认时把本地 planId 当 taskId 提交，后端 `confirm_assignment()` 实际只确认一个 person，前端完整 Plan 与后端 Assignment 不对应。
- `scheduler/` 的 orchestrator 是单任务迷你 Scheduler，未接入真实 API，也未持久化。

目标：把 Command Map 升级为「感知 → World State → 任务池 → 资源 → 硬约束 → 优先级 → 时间 → 空间路线 → 多目标求解 → 可解释 SchedulePlan → 地图比较 → 班组长确认 → Reservation → Assignment → 执行同步 → 异常重调度 → Feedback」的端到端智能调度闭环，全程保持人在回路与可审计。

## What Changes
- 复用并升级 `src/edge_platform/scheduler/` 为唯一调度核心；`services.recommend/confirm_assignment` 迁移为兼容 Adapter（标记 deprecated）。
- 新增统一 **WorldStateSnapshot**（`WS-YYYYMMDD-NNNN`，带版本/时间戳），Plan 必须绑定 snapshotVersion，确认前校验过期（409 PLAN_STALE / WORLD_STATE_CHANGED）。
- 新增 **Reservation** 资源预占层（reserve/renew/release/expire，乐观锁 version 防并发冲突）。
- 新增 **Optimizer 抽象**：`GreedyOptimizer`（有效优先级排序 → 硬约束过滤 → 评分 → greedy 匹配），预留 `CpSatOptimizer` 接口。
- 新增 **Effective Priority**（base + deadline pressure + blocking + safety + aging，配置化可审计，防饥饿）。
- 新增 **Replanner**（局部重调度，冻结 executing/locked，计划稳定性成本）。
- 新增 **Route Graph 匹配**：复用 `spatial/topology.py` Dijkstra，人员位置→最近节点→shortest_path→目标工位→distance/ETA；无拓扑退化到空间距离。
- 新增统一 **SSE** `GET /api/command-map/stream` + polling fallback。
- 新增持久化表（tasks/schedule_requests/schedule_plans/plan_assignments/assignments/resource_reservations/schedule_decisions/schedule_feedback）。
- 统一状态机：以 `contracts/state-machines/task.yaml` 与 `plan.yaml` 为 canonical，scheduler 内部状态做显式映射。
- 前端改造：`app.js` 调度数据全部来自 backend；`scenario-panel` 真实 Plan 审批；`map.js` 真实 Plan 路线；`workbench`/`entity-panel` 调度关系。

**安全边界（不可变）**：调度只做 建议/派工/计划调整，绝不接入急停/限扭/关节实时控制等安全闭环；未经班组长确认不得自动执行；所有确认/驳回/覆盖/策略变更可审计；learning_loop 只产生校准建议，不自动改安全规则或权重。

## Impact
- 受影响既有 spec：`cmd-map-intelligent-scheduling`（主应用 TS 实现，此处为 Python 端，二者为参考关系，不重复建设另一套核心）。
- 受影响代码：
  - `src/edge_platform/scheduler/`（升级 + 新增 models/world_state/route_planner/optimizer/priority/reservation/planner/planner_engine/scheduler_service/replanner/repository）
  - `src/edge_platform/services.py`（recommend/confirm 变兼容 Adapter）
  - `src/edge_platform/server.py`（新增 scheduling/tasks/assignments/resources/stream API）
  - `src/edge_platform/stubs.py`（新增调度表）
  - `ui/command_map/`（app.js / scenario-panel / map.js / workbench / entity-panel）
  - `src/edge_platform/tests/test_scheduling.py`（新增）

## ADDED Requirements
### Requirement: WorldStateSnapshot
系统 SHALL 在每次调度前生成版本化 WorldStateSnapshot（`WS-YYYYMMDD-NNNN`），聚合 pending tasks/people/devices/stations/assignments/reservations/telemetry/positions/safety events/load/battery/topology version；Plan 绑定 snapshot 版本，确认前校验过期与关键变化。

#### Scenario: 过期快照确认
- **WHEN** 对基于旧 snapshot 的 Plan 执行 confirm
- **THEN** 返回 409 `PLAN_STALE` / `WORLD_STATE_CHANGED`，绝不静默执行。

### Requirement: Reservation
系统 SHALL 提供资源预占（Person/Device/Station capacity + 时间窗），支持 reserve/renew/release/expire/recover，用 version 乐观锁阻止并发冲突。

#### Scenario: 并发冲突
- **WHEN** 两个并发请求同时分配同一资源
- **THEN** 仅一个成功，另一个返回 `RESOURCE_CONFLICT`（HTTP 409）。

### Requirement: GreedyOptimizer + Optimizer 抽象
系统 SHALL 通过 `Optimizer.solve(world_state, tasks, candidates, policy)` 抽象求解，提供 GreedyOptimizer（有效优先级排序→硬约束过滤→评分→greedy 匹配），预留 CpSatOptimizer 接口。

#### Scenario: 端到端闭环
- **WHEN** 触发调度请求
- **THEN** 生成可解释 SchedulePlan（含多个 assignment：task/person/device/station/time/route/distance/ETA/score/explanation）。

### Requirement: Effective Priority
系统 SHALL 计算 Effective Priority（base/deadline pressure/blocking/safety/aging），配置化可审计，防止低优先级任务饥饿。

### Requirement: Replanner
系统 SHALL 支持局部重调度（插单/人员不可用/设备离线/电量不足/安全事件/工位不可用/assignment 拒绝或超时/ETA 超阈值/PLLAN 过期），冻结 executing 与人工 pin/freeze 的 assignment，引入计划稳定性成本。

#### Scenario: 设备离线
- **WHEN** 设备离线且其 assignment 受影响
- **THEN** 受影响 Plan 失效或触发 replan，生成 Plan vN+1，标注 unchanged/added/removed/reassigned/delayed。

### Requirement: SSE + polling fallback
系统 SHALL 提供 `GET /api/command-map/stream`（SSE）推送 resource/telemetry/task/assignment/schedule/event 事件，事件带 event_id/event_type/entity_id/version/source_ts/server_ts；保留 polling fallback，SSE 断开时可用。

## MODIFIED Requirements
### Requirement: 语义链路（原 recommend/confirm）
将「前端展示 sample Plan + 后端确认一个 person」修复为：ScheduleRequest → SchedulePlan → Human Confirmation → Reservation → Assignment，确认必须带真实 plan_id/plan_version/world_state_version/actor/reason，后端确认前执行最终约束检查与 Reservation。

### Requirement: 调度数据来源
`app.js` + `scenario-panel` 调度相关数据全部来自 backend；`SAMPLE_DATA.plans` 仅用于明确 offline/demo 模式。

## REMOVED Requirements
### Requirement: services.recommend 作为唯一调度规则
**Reason**: 无法表达联合调度与硬约束闭环。
**Migration**: 迁移为兼容 Adapter（内部走 Scheduler，标记 deprecated），保留旧接口行为；禁止长期维护两套调度规则。