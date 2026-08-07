# Tasks — 智能调度 V2 正确性收敛（ewoh-spark-app 主线）

> 复用并升级 Scheduling V2，不重写。Phase 0 为正确性硬修复（必须最先完成且测试通过）；Phase 1/2 落地基础能力与接口。每个问题完成后立即补测试，不留到最后。

## Phase 0 — 正确性（P0，优先完成）

- [x] Task 0.1: 真实路线起终点
  - [x] 0.1.1 `RoutingService` 接入 spatialEntity 坐标（person/device/station/task → x/y/floor），用最近 route node 作为 A* 起终点；移除"第一个/最后一个节点"盲回退
  - [x] 0.1.2 `RouteCost`/`Route` 增加 `source`(route_graph|euclidean_fallback)、`riskCost`、`congestionCost`、`graphVersion`、`calculatedAt`、`feasible`；Euclidean fallback 必须显式标记
  - [x] 0.1.3 测试：不同 personId 起点真不同 / 不同 taskId 终点真不同 / A 距 5m B 距 100m 时距离权重策略选 A

- [x] Task 0.2: 候选区间 reservation 冲突
  - [x] 0.2.1 `EligibilityContext` 增加 `candidateStartMs`/`candidateEndMs`，冲突判断改用 `existing.start < candidate.end && candidate.start < existing.end`
  - [x] 0.2.2 reservation 支持 person/device/station（tool/vehicle/material 预留），避免任意资源双重预订
  - [x] 0.2.3 测试：person 已有 09:00-10:00，新任务 09:30-10:30 不可派 / device reservation 冲突 / station capacity 冲突

- [x] Task 0.3: 统一任务生命周期
  - [x] 0.3.1 新增共享 `TaskLifecycle`（isSchedulable/isLocked/isExecuting/isTerminal），引用 task service 状态机
  - [x] 0.3.2 solver 移除孤立 `SCHEDULABLE_STATUSES`，改用 `TaskLifecycle.isSchedulable`；task service/CommandMap/Workbench 共用
  - [x] 0.3.3 测试：状态转换 + scheduler eligibility 状态语义一致

- [x] Task 0.4: 抽取 PriorityEngine 并修复 deadline 方向
  - [x] 0.4.1 新增 `PriorityEngine`，从 HeuristicSchedulingSolver 抽取优先级逻辑，返回 `{level, score, factors[], explanation[]}`
  - [x] 0.4.2 修复 deadlineRisk 符号方向：越接近 deadline 分数越小（越紧急）
  - [x] 0.4.3 测试：critical/urgent 优先 / 同优先级 deadline 更近者优先 / waiting age 提高优先级 / 排序方向正确

- [x] Task 0.5: 完整持久化 SchedulingPlanV2 + round-trip
  - [x] 0.5.1 `persistPlan()`/`toPlanV2()` 完整持久化 policyVersion/solverVersion/horizonMinutes/snapshotVersion/scoreBreakdown/metrics/violations/baselineDelta；Assignment 持久化 etaSeconds/distanceMeters/riskLevel/scoreBreakdown/reasons/alternatives/routeId/route source/plannedStart/plannedEnd
  - [x] 0.5.2 移除读取时硬编码 `policyVersion=1`/`solverVersion=heuristic-v2`/`horizonMinutes=480`
  - [x] 0.5.3 测试：plan persist → get 关键字段完全一致（round-trip）

- [x] Task 0.6: Replan 继承真实策略
  - [x] 0.6.1 `PlanService.replan()` 默认继承原方案 policyVersion；如需更换显式 targetPolicyVersion + audit
  - [x] 0.6.2 移除 replan 临时构建全部 weight=1 的 SchedulingPolicy
  - [x] 0.6.3 测试：Replan 使用正确 policyVersion

## Phase 1 — 资源与约束建模

- [ ] Task 1.1: 统一 ResourceState + 设备能力
  - [ ] 1.1.1 `ResourceState` 覆盖 person/device/station/tool/vehicle/material；device 增加 location/capabilities/availabilityWindows/reservations/capacity/battery/fault/telemetryUpdatedAt/version
  - [ ] 1.1.2 任务模型增加 requiredResources/requiredDeviceCapabilities/candidateStations/resourceQuantity/capacity
  - [ ] 1.1.3 测试：在线且电量足够但 capability 不匹配的设备不可执行任务

- [ ] Task 1.2: requiredSkills allOf/anyOf
  - [ ] 1.2.1 技能/资质需求改为 `{allOf, anyOf}` 显式语义，EligibilityService 按此校验
  - [ ] 1.2.2 测试：allOf 缺一不可 / anyOf 任一即可

- [ ] Task 1.3: DecisionTrace
  - [ ] 1.3.1 为每个 Assignment 保存 DecisionTrace（selected/priority/candidates/selectedReason/policyVersion/solverVersion/snapshotVersion），JSONB 存储
  - [ ] 1.3.2 前端默认摘要，点击"为什么"再加载详情
  - [ ] 1.3.3 测试：DecisionTrace 生成与读取

- [ ] Task 1.4: 收敛 legacy scheduler API
  - [ ] 1.4.1 找出所有 legacy `/api/scheduler/plans`(POST/GET)、`confirm` 调用点，标记 deprecated + adapter
  - [ ] 1.4.2 Scheduling.tsx 迁移到 V2 或复用 CommandMap SchedulePanel 能力
  - [ ] 1.4.3 测试：V2 唯一路径，legacy 不新增业务逻辑

## Phase 2 — 实时闭环与局部重排（基础能力）

- [ ] Task 2.1: SSE sequence/version + gap recovery
  - [ ] 2.1.1 SchedulingEvent 增加 entityType/entityVersion；SSE 支持 `sinceSequence`；sequence 缺口时前端停止增量 → 拉最新 snapshot → 恢复
  - [ ] 2.1.2 CommandMap 收敛为 初始 snapshot + ordered SSE + gap recovery + fallback polling
  - [ ] 2.1.3 测试：SSE sequence 缺口能恢复 snapshot

- [ ] Task 2.2: ImpactAnalyzer + 局部重排
  - [ ] 2.2.1 统一异常类型（RESOURCE_OFFLINE/RESERVATION_CONFLICT/PLAN_STALE/ROUTE_BLOCKED 等），含 severity/affectedTaskIds/recommendedAction/canAutoReplan
  - [ ] 2.2.2 ImpactAnalyzer：事件 → 受影响任务 → 冻结 executing/dispatched/locked → 只重排受影响子图；solver 增加 stability/churn penalty
  - [ ] 2.2.3 测试：DEVICE_OFFLINE 触发受影响任务重排 / 无关任务不 churn / ROUTE_BLOCKED 绕路或不可达

## Phase 3 — Benchmark

- [ ] Task 3.1: 基准指标
  - [ ] 3.1.1 建立固定 WorldStateSnapshot fixture 或历史 snapshot benchmark，统计 on-time/late/walking/station wait/utilization/unassigned/violation/soft score/churn/solver p50/p95
  - [ ] 3.1.2 与当前 heuristic 基线对比

# Task Dependencies
- Task 0.1 依赖 spatial 模块；0.2 依赖 0.3（状态）；0.4 依赖 0.3
- Task 0.5/0.6 依赖 schema 扩展
- Task 1.1 依赖 0.3；1.2 依赖 1.1；1.3 依赖 0.5；1.4 依赖 0.5
- Task 2.1 依赖 1.x；2.2 依赖 0.4、0.6
- Task 3.1 依赖全部
- Phase 0 各 Task 相对独立，可并行（0.1–0.6）