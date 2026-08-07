# Tasks — 智能调度执行闭环（ewoh-spark-app 主线）

> 以当前 main 分支 `ewoh-spark-app/` 为唯一主线；`ui/command_map` 与 `src/edge_platform/scheduler` 保留为参考，不外建平行调度系统。Phase 2/3 仅落地接口与可独立运行基础能力，不提交半成品复杂优化器。

## Phase 0 — 正确性

- [x] Task 0.1: 真实前置任务依赖
  - [x] 0.1.1 定位 Task DAG 真实 dependency 数据来源（`ewohProductionTask` 字段或关系表），在 `world-state.service.ts` 填充 `predecessorIds`，移除 `[]` 硬编码
  - [x] 0.1.2 Solver 支持多级依赖 + 环检测（`PREDECESSOR_CYCLE`），未完成 predecessor 记 violation 不派工
  - [x] 0.1.3 单元测试：前置未完成不派工 / 多级依赖顺序 / 环依赖报错

- [x] Task 0.2: 真实资质/技能/占用
  - [x] 0.2.1 校验 person.certifications/skills 与 task.requiredCertifications/requiredSkills 真实字段；缺失列时设计最小向后兼容 migration
  - [x] 0.2.2 `bookedTimeSlots` 改为真实 reservation/占用来源，移除 `[]` 硬编码
  - [x] 0.2.3 单元测试：资质缺失 / 技能缺失 / 时间窗占用冲突

- [x] Task 0.3: Safety 事件映射
  - [x] 0.3.1 安全事件→person/device/station/zone/task 关联解析，精确计算 `safetyBlockedPersonIds`/`safetyBlockedDeviceIds`/`forbiddenZones`，移除空串伪造
  - [x] 0.3.2 无法解析关联对象的事件按策略记录 explainability/audit，不静默忽略
  - [x] 0.3.3 单元测试：L3 事件排除 zone / 解析失败记录

- [x] Task 0.4: SchedulingConstraint 类型系统
  - [x] 0.4.1 在 `shared/api.interface.ts` 定义 hard/soft constraint 类型（见 spec）
  - [x] 0.4.2 Solver 真实执行或明确返回 `UNSUPPORTED_CONSTRAINT`，禁止静默忽略
  - [x] 0.4.3 单元测试：每个 hard constraint 单独可测 + 不支持约束返回 UNSUPPORTED_CONSTRAINT

- [x] Task 0.5: 版本化 SchedulingPolicy
  - [x] 0.5.1 新增 `scheduling-policy.service.ts` 与 version 化 Policy/PolicyConfig（objective 权重/minBatteryPct/maxContinuousLoad/默认时长/horizon/拥堵风险系数/cooldown）
  - [x] 0.5.2 plan 记录 `policyVersion`/`solverVersion`/`snapshotVersion`；移除 SolverService 内 magic numbers
  - [x] 0.5.3 单元测试：策略版本一致可重放

- [x] Task 0.6: 快照新鲜度可靠版本
  - [x] 0.6.1 建立 entity 级 version / 全局 worldVersion / event sequence / canonical hash 判断 freshness
  - [x] 0.6.2 人员身份/位置、任务优先级/deadline、设备状态、route status/risk、reservation 变化使旧 plan stale
  - [x] 0.6.3 approve/dispatch 前强校验；单元测试：entity 变化导致 stale

- [x] Task 0.7: 修复 API 冲突
  - [x] 0.7.1 修复 `scheduler.controller.ts` 重复路由 `POST plans/:planId/reject`（合并为单一 V2 handler，旧 handler 转 deprecated compatibility adapter）
  - [x] 0.7.2 单元测试：reject 路由唯一可调用

## Phase 0.5 — 执行闭环

- [x] Task 0.8: ResourceReservation
  - [x] 0.8.1 新增 resource_reservations 表 + ReservationService（reserve/renew/release/expire，CAS/唯一约束防冲突）
  - [x] 0.8.2 单元测试：同一资源并发抢占仅一个成功

- [x] Task 0.9: DispatchCoordinator
  - [x] 0.9.1 新增 `dispatch-coordinator.service.ts`，单事务原子完成 12 步（spec §事务级 DispatchCoordinator），任一步失败 rollback
  - [x] 0.9.2 更新 production task assigneeId/deviceId 并走合法状态机（不绕过 TaskService）
  - [x] 0.9.3 新增 outbox 表 + domain event 生成
  - [x] 0.9.4 并发测试：两份 plan 抢同一资源；stale plan 与新世界状态并发

## Phase 1 — 智能调度基础

- [x] Task 1.1: 统一资源投影
  - [x] 1.1.1 新增 `resource-projection.service.ts`，person/device/station/tool/material/vehicle → 统一 ResourceState
  - [x] 1.1.2 单元测试：各资源类型投影正确

- [x] Task 1.2: 统一 RouteCostProvider
  - [x] 1.2.1 新增 `route-cost.provider.ts`，Solver 移动成本来自 route graph（distance/ETA/congestion/risk）
  - [x] 1.2.2 assignment 保存 routeId/ETA/distance/risk summary；单元测试：算法成本与地图一致

- [x] Task 1.3: SchedulingSolver 抽象
  - [x] 1.3.1 定义 `scheduling-solver.interface.ts`；`heuristic-scheduling-solver.ts` 迁移现有确定性算法（真实约束/route ETA/score normalization/deterministic replay）；预留 CpSat adapter 接口
  - [x] 1.3.2 单元测试：同 snapshot+policy+solverVersion 确定性重放

- [x] Task 1.4: 可解释动态优先级 + 多目标评分
  - [x] 1.4.1 effectivePriorityScore（base/deadlineRisk/waitingAge/eventSeverity/productionImpact/downstreamBlockingImpact/manualBoost）
  - [x] 1.4.2 多目标 score breakdown（lateness/travel/workloadBalance/stationWait/changeCost/risk/energyCost）
  - [x] 1.4.3 单元测试：critical 不被降级 / aging 防饥饿 / 关键路径加权 / breakdown 可解释

## Phase 2/3 — 接口与基础能力（不完成后台复杂优化器）

- [x] Task 2.1: 实时流
  - [x] 2.1.1 `GET /api/scheduler/v2/stream`（SSE + polling fallback），事件带 version/sequence
  - [x] 2.1.2 前端 api 层接入事件；乱序不覆盖新状态

- [x] Task 2.2: 持久化 ReplanCoordinator
  - [x] 2.2.1 新增 `replan-coordinator.service.ts`，PostgreSQL 幂等去重（orgId+triggerType+entityId+eventVersion）
  - [x] 2.2.2 impact analysis + partial replan：executing/locked 冻结，只重排受影响子图
  - [x] 2.2.3 单元测试：设备离线重排 / 无关任务冻结 / 幂等去重

## Phase 4 — 测试 + 质量

- [x] Task 4.1: 补测试（Unit + Solver invariants + Concurrency + Integration + Failure injection）
  - [x] 4.1.1 每个 hard constraint 单测；solver invariants（同一资源不重叠/predecessor 先于 successor/禁入区不产生 assignment/资质不符不派/executing+locked 不被改/确定性重放）
  - [x] 4.1.2 并发测试（双 dispatch / 抢 person / 抢 device / stale 并发）
  - [x] 4.1.3 集成测试（task→run→shadow→approve→reserve→dispatch→task 状态→assignment event→world state→CommandMap）
  - [x] 4.1.4 failure injection（person unavailable/device offline/low battery/blocked route/safety event/deadline risk→conflict/replan）

- [x] Task 4.2: 质量门禁
  - [x] 4.2.1 运行 lint/typecheck/tests/build，修复本次改动引入的失败；原有 schedule 测试不退化

# Task Dependencies
- Phase 0 各 Task 相对独立，可并行（0.1–0.7）
- Task 0.8/0.9 依赖 Task 0.4（constraint 类型）、0.6（快照校验）
- Task 1.1 依赖 schema；1.2 依赖 skeleton/routing；1.3 依赖 1.2；1.4 依赖 1.3
- Task 2.1 依赖 1.x；2.2 依赖 0.6、1.3
- Task 4.x 依赖全部