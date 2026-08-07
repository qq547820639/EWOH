# Checklist — 智能调度 V2 正确性收敛

## Phase 0 正确性
- [x] RoutingService 以真实 spatial 坐标解析起终点，移除"首/末节点"盲回退
- [x] RouteCost/Route 输出含 source/riskCost/congestionCost/graphVersion/calculatedAt/feasible；Euclidean fallback 显式标记 source=euclidean_fallback
- [x] 不同 personId 的 route 起点真不同；不同 taskId 的终点真不同
- [x] 距离权重策略下距任务近的人员被优先选择
- [x] EligibilityContext 含 candidateStartMs/candidateEndMs，reservation 冲突用标准区间重叠判断
- [x] reservation 覆盖 person/device/station（tool/vehicle/material 预留），无双重预订
- [x] 人员已有 09:00-10:00 reservation，新任务 09:30-10:30 不可分派
- [x] 共享 TaskLifecycle（isSchedulable/isLocked/isExecuting/isTerminal），solver 不再孤立 SCHEDULABLE_STATUSES
- [x] task service / scheduler / CommandMap / Workbench 共用同一状态语义
- [x] PriorityEngine 独立于 HeuristicSchedulingSolver，返回 {level, score, factors[], explanation[]}
- [x] deadline 方向正确：越接近 deadline 越紧急（分数越小）
- [x] critical/urgent 优先；同优先级 deadline 更近者优先；waiting age 提高优先级
- [x] persistPlan/toPlanV2 完整持久化 policyVersion/solverVersion/horizonMinutes/snapshotVersion/scoreBreakdown/metrics/violations/baselineDelta
- [x] 每条 Assignment 持久化 etaSeconds/distanceMeters/riskLevel/scoreBreakdown/reasons/alternatives/routeId/route source/plannedStart/plannedEnd
- [x] 读取数据库时不硬编码回填 policyVersion/solverVersion/horizonMinutes
- [x] plan persist → get 关键字段完全一致（round-trip 测试通过）
- [x] replan 默认继承原方案 policyVersion，不构建 weight=1 假策略；换策略需显式 targetPolicyVersion + audit

## Phase 1 资源与约束
- [ ] ResourceState 覆盖 person/device/station/tool/vehicle/material；device 含 location/capabilities/availabilityWindows/reservations/capacity/battery/fault/telemetryUpdatedAt/version
- [ ] 任务模型含 requiredResources/requiredDeviceCapabilities/candidateStations/resourceQuantity/capacity
- [ ] 在线且电量足够但 capability 不匹配的设备不可执行任务
- [ ] requiredSkills/requiredCertifications 使用 {allOf, anyOf} 显式语义
- [ ] DecisionTrace 生成并持久化（JSONB），前端摘要 + 按需加载详情
- [ ] legacy `/api/scheduler/plans` 与 confirm 标记 deprecated + adapter；Scheduling.tsx 迁移到 V2

## Phase 2 实时闭环
- [ ] SchedulingEvent 含 entityType/entityVersion；SSE 支持 sinceSequence
- [ ] sequence 缺口时前端停止增量 → 拉最新 snapshot → 恢复
- [ ] 统一异常类型（RESOURCE_OFFLINE/RESERVATION_CONFLICT/PLAN_STALE/ROUTE_BLOCKED 等）含 severity/affectedTaskIds/recommendedAction/canAutoReplan
- [ ] ImpactAnalyzer 冻结 executing/dispatched/locked，只重排受影响子图；solver 有 stability/churn penalty
- [ ] DEVICE_OFFLINE 触发受影响任务重排；无关任务不 churn；ROUTE_BLOCKED 绕路或不可达

## Phase 3 Benchmark
- [ ] 建立固定 snapshot fixture/historical snapshot benchmark，统计 on-time/late/walking/station wait/utilization/unassigned/violation/soft score/churn/solver p50/p95
- [ ] 与当前 heuristic 基线对比

## 质量
- [ ] 第 11 节 25 项测试要求全部覆盖或明确记录未覆盖原因
- [ ] lint / typecheck / test / build 全部通过，原有 646 测试不退化