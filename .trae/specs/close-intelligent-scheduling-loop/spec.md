# 智能调度执行闭环 Spec（ewoh-spark-app 主线 · Phase 0/0.5/1）

## Why

`ewoh-spark-app` 的 `server/modules/scheduler/` 已具备 Scheduling V2（WorldStateSnapshot / Eligibility / Solver / Plan A/B/C / RouteGraph / approve/reject/dispatch / replan），但它是「可演示的调度」，不是「可闭环运行的调度」。真实仓库扫描确认存在 10 类数据/执行断点：

1. **前置任务断点**：`world-state.service.ts` 把 `predecessorIds` 硬编码为 `[]`，真实 DAG 依赖未接入，导致 `PREDECESSOR` 约束形同虚设。
2. **资质/技能断点**：`solver.service.ts` 把 `certifications: []`、`requiredCertifications: []`、`bookedTimeSlots: []` 硬编码，Eligibility 的资质/占用校验未接入真实字段。
3. **安全映射断点**：`safetyBlockedPersonIds` 由 L3 事件映射为 `''`（伪造），无法影响具体 person/device/station/zone/task。
4. **Constraint 类型不一致**：接口声明 LOCKED_TIME/FORBIDDEN_ZONE/MIN_BATTERY 等，Solver 只处理 LOCKED_PERSON/LOCKED_DEVICE，其余被静默忽略。
5. **Magic numbers**：`DEFAULT_DURATION_MS=30min`、`minBatteryPct=15`、`maxContinuousLoad=0.9`、`horizonMinutes=480`、客观权重、步行 1m/s 全部散落硬编码，无版本化 Policy。
6. **快照新鲜度薄弱**：`fingerprint()` 只用 5 个计数（openEvents/unavailablePersons/lowBattery/…），entity 级变化（人员身份/位置/优先级/deadline/route 状态/reservation）无法使旧 plan 正确 stale。
7. **dispatch 无闭环**：`dispatchPlan()` 只改 plan/assignment 状态 + 写事件，无资源 reservation、无 Task 状态机推进、无双重占用防护、无 outbox、非原子。
8. **统一资源模型缺失**：无 ResourceProjectionService，调度只理解 person+device。
9. **路径成本分裂**：Solver 用欧氏距离 + 1m/s，RoutingService 用 route graph/ETA，二者不一致。
10. **Solver 未抽象**：`SolverService` 为具体类，无 `SchedulingSolver` 接口，无法替换为 CP-SAT。
11. **API 冲突**：`scheduler.controller.ts` 存在重复路由 `POST plans/:planId/reject`（L61 与 L135），NestJS 会抛重复路由错误。

Goal：把现有 V2 升级为真正的智能调度闭环——真实约束、真实路线成本、版本化策略、可靠快照、事务级 dispatch、可解释求解、实时同步、影响分析式局部重排，同时保留人工审批与安全边界。

## What Changes

聚焦 Phase 0（正确性）、Phase 0.5（执行闭环）、Phase 1（智能调度基础），Phase 2/3 仅落地接口与可独立运行的基础能力，不提交半成品复杂优化器。

- **Phase 0 正确性**：接入真实 predecessor 依赖 + 环检测；接入 person.certifications / task.requiredCertifications / requiredSkills / bookedTimeSlots；Safety 事件映射到具体 person/device/station/zone/task；建立 SchedulingConstraint 类型系统并让 Solver 真实执行或明确返回 UNSUPPORTED_CONSTRAINT；magic number 抽成版本化 SchedulingPolicy/PolicyConfig；快照新鲜度改为 entity 级 version 机制；修复重复 reject 路由。
- **Phase 0.5 执行闭环**：ResourceReservation + DispatchCoordinator（原子 12 步，rollback）、outbox/domain event、audit、并发防双派（唯一约束/CAS）、Task 状态机合法推进。
- **Phase 1 智能调度基础**：ResourceProjectionService（person/device/station/tool/material/vehicle 统一 ResourceState）；RouteCostProvider（Solver 与地图共用 route graph 的 distance/ETA/congestion/risk）；SchedulingSolver 接口 + HeuristicSchedulingSolver（保留现有算法）+ 预留 CpSatSchedulingSolver adapter；effectivePriorityScore（可解释）；多目标 score breakdown；versioned policy。
- **Phase 2/3 接口与基础**：SSE `GET /api/scheduler/v2/stream`（delta + version/sequence）；持久化 ReplanCoordinator（PostgreSQL 幂等去重键 orgId+triggerType+entityId+eventVersion）；impact analysis + partial replan 接口定义；constraint 支持矩阵与动态优先级可解释模型。

**BREAKING**：SchedulerController 重复路由 `POST plans/:planId/reject` 需合并为单一 V2 handler（旧 handler 保留为 compatibility adapter，标记 deprecated）。

## Impact

- 受影响既有 spec：`cmd-map-intelligent-scheduling`（已完成 V2 基础，此处为执行闭环深化）、`cmd-map-edge-scheduling`（Python 参考，不改动）。
- 受影响代码（`ewoh-spark-app`）：
  - `server/modules/scheduler/world-state.service.ts`（snapshot freshness + predecessor）
  - `server/modules/scheduler/solver.service.ts`（抽象 + 真实约束 + route cost + 可解释评分）
  - `server/modules/scheduler/eligibility.service.ts`（真实资质/技能/占用）
  - `server/modules/scheduler/plan.service.ts`（dispatch 走 DispatchCoordinator）
  - `server/modules/scheduler/scheduler.controller.ts`（修复重复路由 + v2 收敛）
  - `server/modules/scheduler/scheduler.service.ts`（编排 + SSE + replan coordinator）
  - 新增 `dispatch-coordinator.service.ts`、`resource-projection.service.ts`、`route-cost.provider.ts`、`scheduling-solver.interface.ts`、`heuristic-scheduling-solver.ts`、`scheduling-policy.service.ts`、`replan-coordinator.service.ts`、`stream gateway`
  - `server/database/schema.ts` + 新 migration（resource_reservations、outbox、policy_config、entity version 等）
  - `shared/api.interface.ts`（SchedulingConstraint / PolicyConfig / ResourceState / DispatchResult / ScoreBreakdown / 事件类型）
  - 前端 `client/src/pages/CommandMap/panels/SchedulePanel.tsx`、`CommandMap.tsx`、`client/src/api/scheduler.ts`

## ADDED Requirements

### Requirement: 真实前置任务依赖
系统 SHALL 从真实的 Task DAG 读取 `predecessorIds` 并写入 WorldStateSnapshot；Solver 对未完成 predecessor 的任务记 violation 且不派工；支持多级依赖；拒绝环依赖（`PREDECESSOR_CYCLE`）。

#### Scenario: 前置未完成
- **WHEN** 任务 T2 依赖 T1 且 T1 未完成
- **THEN** T2 不产生 assignment，violation 含 `predecessor_pending`。

### Requirement: 真实资质/技能/占用
系统 SHALL 从 person.certifications / skills 与 task.requiredCertifications / requiredSkills 接入 Eligibility；占用改为真实 `bookedTimeSlots` / reservation 校验，不再硬编码空数组。

#### Scenario: 资质缺失
- **WHEN** 候选缺少任务所需 certification
- **THEN** 该候选 ineligible，reason 含 `missing_certification`。

### Requirement: Safety 事件映射
系统 SHALL 依据安全事件关联的 person/device/station/zone/task 精确计算 `safetyBlockedPersonIds`/`safetyBlockedDeviceIds`/`forbiddenZones`；无法解析关联对象的事件按策略记录 explainability/audit，不静默忽略、不伪造空串。

#### Scenario: L3 事件影响
- **WHEN** 某 zone 存在 open L3 安全事件
- **THEN** 该 zone 的候选任务被硬约束排除，reason 含 `safety_block`。

### Requirement: SchedulingConstraint 类型系统
系统 SHALL 建立可扩展 hard/soft constraint 模型；API 接受的所有 constraint 必须被 Solver 真实执行，或显式返回 `UNSUPPORTED_CONSTRAINT`；禁止静默忽略。Hard 至少含 REQUIRED_SKILL/REQUIRED_CERTIFICATION/PERSON_AVAILABLE/DEVICE_AVAILABLE/RESOURCE_TIME_WINDOW/NO_DOUBLE_BOOKING/PREDECESSOR/FORBIDDEN_ZONE/MIN_BATTERY/MAX_WORKLOAD/SAFETY_BLOCK/LOCKED_PERSON/LOCKED_DEVICE/LOCKED_TIME/LOCKED_ASSIGNMENT；Soft 至少含 MIN_TRAVEL_TIME/BALANCE_WORKLOAD/MIN_CHANGE/MIN_WAIT/PREFER_SAME_TEAM/PREFER_NEARBY_RESOURCE。

#### Scenario: 求解器不支持某约束
- **WHEN** 提交未实现的约束类型
- **THEN** 返回 `UNSUPPORTED_CONSTRAINT`，不静默忽略。

### Requirement: 版本化 SchedulingPolicy
系统 SHALL 将 objective 权重、minBatteryPct、maxContinuousLoad、默认任务时长、horizonMinutes、拥堵/风险系数、触发 cooldown 等集中为带 version 的 SchedulingPolicy/PolicyConfig；每个 plan 必须记录 `policyVersion`/`solverVersion`/`snapshotVersion`；可审计、可重放。

### Requirement: 快照新鲜度可靠版本
系统 SHALL 用 entity 级 version / 全局 monotonic worldVersion / event sequence / canonical hash 组合判断 freshness；人员身份与位置、任务优先级/deadline、设备状态、route status/risk、reservation 等变化必须使旧 plan 进入 stale；approve/dispatch 前做强校验。

### Requirement: 事务级 DispatchCoordinator
系统 SHALL 提供 DispatchCoordinator，一次 dispatch 在单个 PostgreSQL 事务内原子完成：校验 plan status/version → 校验 snapshot freshness → 重验全部 hard constraints → 创建 reservation → 防双重占用（唯一/排他约束）→ 更新 production task assigneeId/deviceId 并走合法状态机 → assignment→dispatched → plan→dispatched → 写 assignment event → 写 audit → 生成 outbox/domain event；任一步失败全量 rollback；不绕过 TaskService 状态机。

#### Scenario: 并发双派
- **WHEN** 两份 plan 同时 dispatch 抢占同一资源
- **THEN** 仅一份成功，另一份返回 `RESOURCE_CONFLICT`（HTTP 409）。

### Requirement: 统一资源投影
系统 SHALL 提供 ResourceProjectionService，将 person/device/station/tool/material/vehicle 投影为统一 ResourceState（id/type/status/capabilities/certifications/location/availableWindows/reservations/battery/load/fatigue/health/version），优先复用现有表。

### Requirement: 统一 RouteCostProvider
系统 SHALL 提供 RouteCostProvider；Solver 优化所用的 travel distance/ETA/congestion/route risk 必须来自与地图展示相同的 route graph 数据；assignment 保存 routeId/ETA/distance/risk 且与地图同 version。

#### Scenario: 算法与地图一致
- **WHEN** 求解器计算移动成本
- **THEN** 使用 route graph 的 ETA，而非坐标欧氏距离 + 固定 1m/s。

### Requirement: SchedulingSolver 抽象
系统 SHALL 定义 `SchedulingSolver` 接口，提供 HeuristicSchedulingSolver（保留现有确定性启发式，支持真实约束/真实 route ETA/score normalization/dynamic priority/explanation breakdown/deterministic replay）；预留 CpSatSchedulingSolver adapter（不引入 LLM 作为硬约束求解器）。

### Requirement: 可解释动态优先级
系统 SHALL 在保留业务 priority 基础上计算 `effectivePriorityScore`（base + deadlineRisk + waitingAge + eventSeverity + productionImpact + downstreamBlockingImpact + manualBoost）；critical/urgent 语义不被削弱；aging 防饥饿；DAG 关键路径阻塞任务加权；计算可解释，UI 可见「为什么优先」。

### Requirement: 多目标评分分解
系统 SHALL 输出 objective score breakdown（lateness/travel/workloadBalance/stationWait/changeCost/risk/energyCost），不返回无法解释的单一 total。

### Requirement: 实时流同步
系统 SHALL 提供 `GET /api/scheduler/v2/stream`（SSE + polling fallback），事件带 version/sequence，避免乱序覆盖；至少覆盖 world.person.updated / world.device.updated / world.route.updated / task.updated / safety.updated / scheduling.run.* / plan.updated / plan.stale / assignment.reserved/dispatched/executing/exception/completed。

### Requirement: 持久化 ReplanCoordinator
系统 SHALL 提供 ReplanCoordinator，支持 TASK_CREATED/UPDATED/PERSON_UNAVAILABLE/DEVICE_OFFLINE/DEVICE_LOW_BATTERY/BOTTLENECK_DETECTED/DEADLINE_AT_RISK/SAFETY_EVENT/ZONE_RESTRICTED；用 PostgreSQL 持久化幂等去重（orgId+triggerType+entityId+eventVersion），不以进程内 Map；实现 impact analysis + partial replan：executing/locked 冻结，只重排受影响任务及依赖子图。

## MODIFIED Requirements

### Requirement: 求解器（原 SolverService）
由「具体类 + 硬编码权重 + 空数组」升级为「SchedulingSolver 接口 + HeuristicSchedulingSolver + 真实约束 + RouteCostProvider + 版本化 policy + score breakdown + effectivePriorityScore」。

### Requirement: 下发（原 dispatchPlan）
由「只改状态」升级为「DispatchCoordinator 原子闭环 + reservation + task 状态机 + outbox + 并发防双派」。

### Requirement: 快照校验（原 assertFreshForApprove）
由「5 个计数」升级为「entity version / worldVersion / event sequence / hash」可靠机制。

### Requirement: 调度 API（原 SchedulerController）
修复重复 `plans/:planId/reject` 路由；新主线统一为 `/api/scheduler/v2/*`；旧接口保留为 deprecated compatibility adapter。

## REMOVED Requirements

### Requirement: 硬编码空数组作为正式实现
**Reason**: 存在真实数据来源时 `predecessorIds:[]`、`certifications:[]`、`requiredCertifications:[]`、`bookedTimeSlots:[]`、`safetyBlockedPersonIds` 空串会破坏正确性。
**Migration**: 全部接入真实 schema/API 字段；无可解析关联对象的安全事件按策略记录而不是伪造。

### Requirement: 坐标欧氏距离作为正式移动成本
**Reason**: 与 route graph 展示不一致，导致「算法选最近但地图更远」。
**Migration**: 统一走 RouteCostProvider。