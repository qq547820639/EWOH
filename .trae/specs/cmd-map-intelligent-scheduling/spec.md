# 指挥地图智能调度工作台 Spec

## Why
当前「指挥地图 / Command Map」停留在「地图展示 + 人员推荐 + 人工确认」模式：`scheduler.service.ts` 用固定权重 Top-N 生成 3 个静态方案（keep/cap/bal），`SchedulePanel` 只做 confirm/reject/dispatch，`ui/command_map` 与 `src/edge_platform/scheduler` 的原型逻辑与主应用脱节。缺少真正的联合调度求解、World State 快照、Route Graph、方案版本校验、Replan 闭环。

目标：把 Command Map 升级为完整的「感知 → 事件 → 方案 → 约束校验 → 地图预演 → 人工审批 → 派工 → 反馈 → 异常重调度」智能调度工作台。确定性 Solver 负责调度，LLM 仅用于解释。

## What Changes
- 新增统一 **WorldStateSnapshot**：版本化快照（`WS-YYYYMMDD-NNNN`），调度前先成快照，方案必须绑定 snapshotVersion，Approve 前校验快照是否过期（409 PLAN_STALE）。
- 将现有 `recommend()`/candidate 逻辑收敛为 **EligibilityService**（硬约束过滤，输出 `eligible + reasons`），不再让固定权重 Top-N 直接决定调度。
- 新增确定性 **Scheduling Solver**（可解释启发式 + 加权软目标，软目标抽成 `SchedulingPolicy`），做「任务 × 人员 × 设备 × 时间窗」联合调度，一次生成 **Plan A/B/C** 三套候选方案。
- 新增 **Route Graph**（RouteNode/RouteEdge + A*/最短路径 + ETA），替换「是否同区域」作为距离依据。
- 新增 **Scheduler Trigger**（STATION_BACKLOG / TASK_DELAY / PERSON_UNAVAILABLE / DEVICE_OFFLINE / LOW_BATTERY / ANDON / PRIORITY_CHANGED / ROUTE_BLOCKED / WORKLOAD_RISK / MANUAL_REPLAN），带 debounce/cooldown。
- 新增 **Replan 原则**：冻结 executing/locked assignment，重排未来 30–60 分钟未执行任务，引入 changeCost 求稳定。
- 新增独立 **Scheduling API**（runs / plans / approve / reject / dispatch / replan / compare / routes）。
- **Scenario Panel 重做**为 Plan 审批：Plan Header + KPI + Assignment Changes + Approve/Reject/Compare/Adjust/Replan。
- **地图轨迹**改用真实 Plan Route：实线=已确认路径，虚线=Shadow Plan 未审批路线，半透明人员=预测位置。
- 新增 **Compare Mode**：Plan A vs B 的 assignment 变化、路线、延期、walking、workload、station wait 对比。
- 新增 **Explainability**：每个 assignment 返回 reasons + alternatives。
- 新增数据库表：`scheduling_runs`、`scheduling_plans`、`scheduling_plan_assignments`、`scheduling_constraints`、`world_state_snapshots`、`route_nodes`、`route_edges`、`assignment_events`（PostgreSQL migration）。
- 审计：generate/approve/reject/adjust/replan/dispatch 均写审计（actor/action/timestamp/planId/version/before/after/reason）。

**安全边界**：本改造只做 推荐/派工/计划调整，绝不接入实时电机/关节控制/急停；实时安全闭环留在设备本地控制器。

## Impact
- 受影响的既有 spec：`build-embodied-factory-os`（调度仿真）、`realtime-ingest-and-gamification`（指挥地图）、`production-ux-deepening`（调度面板）。
- 受影响代码（主应用 `ewoh-spark-app`）：
  - `server/modules/scheduler/scheduler.service.ts`（重构为调度域入口）
  - `server/modules/scheduler/scheduler.controller.ts`（新增 API）
  - `server/database/schema.ts`（新增表）
  - `db/migrations/standalone_006_scheduling.sql`（新增 migration，注册进 `db/runner/run_migrations.js`）
  - `client/src/pages/CommandMap/CommandMap.tsx`、`panels/SchedulePanel.tsx`（接入真实 Plan）
  - `client/src/api/scheduler.ts`（新增 API 封装）
- 受影响代码（原型 `src/edge_platform/scheduler`、`ui/command_map`）：作为参考保留，不承载核心调度域。

## ADDED Requirements

### Requirement: WorldStateSnapshot
系统 SHALL 在每次调度前先生成版本化 WorldStateSnapshot，包含人员状态/坐标/当前任务/待处理任务/设备状态/工位状态/backlog/电量/风险事件/路线状态/禁行区域/已锁定 assignment，并生成 `snapshotVersion`。

#### Scenario: 过期快照校验
- **WHEN** 对基于旧 snapshot 生成的 Plan 执行 Approve
- **THEN** 后端返回 409 PLAN_STALE，提示「该方案生成后现场状态已发生变化，请重新计算」，绝不静默执行过期计划。

### Requirement: Eligibility 层
系统 SHALL 提供 EligibilityService，对 (person, task, device) 校验技能/认证/在岗/时间冲突/风险/设备可用/能力/离线/电量/区域权限/前置任务/连续作业/安全等硬约束，输出 `eligible + reasons`，仅 eligible 候选进入 Solver。

#### Scenario: 技能不匹配
- **WHEN** 候选人员缺少任务所需技能
- **THEN** 该人员标记 ineligible，reason 含 `missing_skill`，不进入求解。

### Requirement: Scheduling Solver 联合调度
系统 SHALL 提供确定性 Solver，对「一批任务 × 多人员 × 多设备 × 时间窗」做联合调度，满足硬约束（技能/设备/availability/单人单时段/单设备单任务/predecessor/earliestStart/deadline/电量/禁行/冻结执行中/不修改人工锁定），最小化加权软目标（延期成本/移动时间距离/工位等待/负荷不均衡/连续作业/低电量风险/变更成本），软目标权重来自可配置 SchedulingPolicy。

#### Scenario: 生成三方案
- **WHEN** 触发一次调度
- **THEN** Solver 生成 Plan A（交付优先）、Plan B（人员负荷优先）、Plan C（均衡），三方案目标权重不同。

#### Scenario: 无可行解
- **WHEN** 某任务在硬约束下无任何可行 (person, device)
- **THEN** 不生成虚假 assignment，并记录 violation/reason。

### Requirement: Route Graph 与 ETA
系统 SHALL 提供 RouteNode/RouteEdge 数据结构与 A*/最短路径计算，输出 Route（distanceMeters/etaSeconds/nodes/geometry），路径成本考虑 distance/congestion/risk/blocked edge。

#### Scenario: blocked 边不可选
- **WHEN** 某 route edge status=blocked/congested 且不可通行
- **THEN** Solver/路径计算不选用该边，被阻塞任务触发 ROUTE_BLOCKED 重调度。

### Requirement: Scheduling Trigger 与 debounce
系统 SHALL 提供 TriggerService，识别 STATION_BACKLOG 等触发源并发起 SchedulingRun，带 debounce/cooldown（如 30 秒内同类型触发合并）。

#### Scenario: LINE-B backlog 升高
- **WHEN** LINE-B backlog 超过阈值触发调度
- **THEN** 生成 SchedulingRun，随后产出 Plan A/B/C，且 30 秒内同类型触发被合并。

### Requirement: Plan 审批与 Replan
系统 SHALL 支持 Approve/Reject/Compare/Adjust/Replan。人工锁定（如 TASK-128→P008）转为 Locked Constraint 后 Replan，生成新版本 Plan，而非直接改写 Solver 结果；Replan 冻结 executing 与已锁定任务。

#### Scenario: 人工锁定后 Replan
- **WHEN** 主管锁定 TASK-128 给 P008 并 Replan
- **THEN** 生成 Plan v2，锁定不被破坏，整体仍可行。

### Requirement: Assignment 生命周期与事件
系统 SHALL 支持 Assignment 状态机（proposed→approved→dispatched→acknowledged→executing→completed，异常 blocked/failed/cancelled），每次状态变化写 assignment_events。

### Requirement: Explainability
系统 SHALL 为每个 assignment 返回解释数据（reasons 数组 + alternatives 备选人及未选原因），前端人员详情展示。

### Requirement: Compare Mode
系统 SHALL 支持 Plan A vs B 对比，展示 assignment 变化、路线、延期、walking、workload、station wait 变化。

## MODIFIED Requirements

### Requirement: 调度方案生成（原 generatePlans）
将原「固定权重生成 keep/cap/bal 三静态方案 + SAMPLE_DATA」改为由 Deterministic Solver + Eligibility + RouteGraph 生成真实 SchedulingPlan（含 planId/version/status/trigger/snapshotVersion/assignments/metrics/baselineDelta/violations）。SAMPLE_DATA.plans 仅作 Demo fallback，真实后端连接成功时必须使用真实 Plan。

### Requirement: Scenario Panel（原 SchedulePanel）
由「一个方案选一个受影响人员再确认」改为「Plan 审批」：展示 Plan Header/KPI/Assignment Changes，操作 Approve/Reject/Compare/Adjust/Replan。

### Requirement: 指挥地图轨迹（原 yaw 延长）
预测轨迹由「根据 yaw 往前延长」改为基于真实 Plan Route：实线=确认路径，虚线=Shadow 未审批路线，半透明人员=预测位置，任务点=目标工位，拥堵/封闭区域特殊标记。

### Requirement: 人员/任务交互详情
点击人员/任务时展示调度解释（为何选中、备选人）、路径、ETA、负荷等（沿用现有 UI 风格）。

## REMOVED Requirements

### Requirement: SAMPLE_DATA.plans 作为生产数据源
**Reason**: 静态样本数据无法支撑真实求解与审批闭环。
**Migration**: 保留为 Demo fallback；真实后端返回真实 SchedulingPlan 时前端必须使用真实数据。

### Requirement: 固定权重 Top-N 直接决定最终调度
**Reason**: 无法表达联合调度与硬约束。
**Migration**: 收敛为 EligibilityService 候选生成 + Solver 求解。