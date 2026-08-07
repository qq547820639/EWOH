# 智能调度 V2 正确性收敛（Scheduling V2 correctness）Spec

## Why
Scheduling V2 已具备闭环骨架（快照/求解/审批/下发/重排/SSE），但存在若干 P0 正确性缺陷：路线起终点未使用真实空间位置、reservation 时间冲突检查未用候选时间窗、task 生命周期状态散落多处、动态优先级 deadline 方向符号错误、方案元数据未完整持久化、重排未继承真实策略、legacy 与 V2 调度 API 并存。这些缺陷使调度结果不可信、不可复现、不可追溯。

## What Changes
- **BREAKING** 修复 `RoutingService.startNodeForPerson()` / `goalNodeForTask()`：person/device/station/task → spatialEntity → x/y/floor → 最近 route node → A*；不同人员/任务计算真实不同路线。Euicun fallback 显式标记 `source`。
- **BREAKING** `Route`/`RouteCost` 输出增加 `source`、`riskCost`、`congestionCost`、`graphVersion`、`calculatedAt`、`feasible`。
- **BREAKING** `EligibilityContext` 增加 `candidateStartMs`/`candidateEndMs`，reservation 冲突改用标准区间重叠判断（`existing.start < candidate.end && candidate.start < existing.end`）。
- **BREAKING** 新增共享 `TaskLifecycle`（isSchedulable/isLocked/isExecuting/isTerminal），solver/scheduler/task service/CommandMap/Workbench 共用同一状态语义。
- **BREAKING** 将优先级逻辑从 `HeuristicSchedulingSolver` 抽取为独立 `PriorityEngine`，返回 `{level, score, factors[], explanation[]}`，修复 deadline 方向（越近越紧急）。
- **BREAKING** `PlanService.persistPlan()`/`toPlanV2()` 完整持久化 policyVersion/solverVersion/horizonMinutes/snapshotVersion/scoreBreakdown/metrics/violations/baselineDelta；Assignment 持久化 etaSeconds/distanceMeters/riskLevel/scoreBreakdown/reasons/alternatives/routeId/route source/plannedStart/plannedEnd。禁止读取时硬编码回填。
- **BREAKING** `PlanService.replan()` 默认继承原方案 policyVersion，不再临时构建全部 weight=1 的策略。
- `requiredSkills`/`requiredCertifications` 语义改为显式 `{allOf, anyOf}`。
- 统一 `ResourceState`（person/device/station/tool/vehicle/material），device 增加 location/capabilities/availabilityWindows/reservations/capacity/battery/fault/telemetryUpdatedAt/version。
- Device 匹配增强：任务增加 requiredResources/requiredDeviceCapabilities/candidateStations/resourceQuantity/capacity。
- 新增 `DecisionTrace`（可 JSONB 存储，前端按需加载详情）。
- 收敛 legacy scheduler API：以 V2 为目标，legacy 标记 deprecated + adapter，最终移除。

## Impact
- Affected specs: 智能调度执行闭环（close-intelligent-scheduling-loop，已完成）
- Affected code: `server/modules/scheduler/{routing,eligibility,heuristic-scheduling-solver,plan,solver,world-state}.service.ts`、`server/modules/task/task.service.ts`、`shared/api.interface.ts`、`server/database/schema.ts`、`client/.../CommandMap`、`client/src/api/scheduler*`、`client/src/pages/Scheduling/Scheduling.tsx`

## ADDED Requirements
### Requirement: 真实路线起终点
系统 SHALL 基于人员/设备/工位/任务的空间实体坐标解析路线起终点，使用最近 route node 做 A*，不同人员/任务得到真实不同路线；无法解析时使用 Euclidean fallback 并在 `RouteCost.source` 显式标记 `euclidean_fallback`。

#### Scenario: 人员 A/B 距任务不同距离
- **WHEN** 人员 A 距任务 5m、人员 B 距任务 100m，其他条件一致且采用距离权重策略
- **THEN** 求解器优先选择 A

### Requirement: 候选区间 reservation 冲突
系统 SHALL 按候选时间区间 `[candidateStartMs, candidateEndMs]` 与既有 reservation 做标准区间重叠判断，覆盖 person/device/station/tool/vehicle/material，避免任意资源双重预订。

#### Scenario: 人员已有 09:00-10:00 reservation
- **WHEN** 新任务候选区间为 09:30-10:30
- **THEN** 该人员不可分派（返回 time_conflict）

### Requirement: PriorityEngine 方向正确
系统 SHALL 提供独立 PriorityEngine，返回 `{level, score, factors[], explanation[]}`；所有因素方向一致，分数越小越紧急；同等基础优先级下 deadline 更近者优先。

#### Scenario: 同优先级 deadline 更近
- **WHEN** 两个同优先级任务，一个 10:00 到期、一个 12:00 到期
- **THEN** 10:00 到期任务优先

### Requirement: 方案完整持久化 round-trip
系统 SHALL 保证一个 SchedulingPlanV2 求解 → persist → getPlan 后除 DB 生成字段外语义完全等价，不硬编码回填。

### Requirement: Replan 继承真实策略
系统 SHALL 让 replan 默认继承原方案 policyVersion；如需更换策略必须显式传 targetPolicyVersion 并留 audit。

### Requirement: DecisionTrace
系统 SHALL 为每个 Assignment 保存可解释决策轨迹（selected/priority/candidates/selectedReason/policyVersion/solverVersion/snapshotVersion），前端默认只显示摘要，点击"为什么"再加载详情。

## MODIFIED Requirements
### Requirement: 统一任务生命周期
task service、scheduler、CommandMap、Workbench SHALL 共享 `TaskLifecycle` 状态语义（isSchedulable/isLocked/isExecuting/isTerminal），solver 不再孤立维护 `SCHEDULABLE_STATUSES`。

### Requirement: 资源与设备能力匹配
device ResourceState SHALL 包含 location/capabilities/availabilityWindows/reservations/capacity/battery/fault/telemetryUpdatedAt/version；任务 requiredResources/requiredDeviceCapabilities 必须与设备能力真实匹配，禁止仅凭 online+battery 决定。

### Requirement: requiredSkills allOf/anyOf
任务技能/资质要求 SHALL 使用 `{allOf, anyOf}` 显式语义，禁止依赖模糊数组字段推断 AND/OR。

### Requirement: legacy API 收敛
Scheduling V2 SHALL 为唯一目标模型；legacy `/api/scheduler/plans/confirm` 等标记 deprecated + adapter，Scheduling.tsx 迁移到 V2 或复用 CommandMap SchedulePanel。

## REMOVED Requirements
### Requirement: 无 legacy 平行调度逻辑
**Reason**: 维护两套独立 scheduling 业务逻辑成本高且易不一致。
**Migration**: 短期保留 adapter，标记 deprecated，最终移除；全部走 Scheduling V2。