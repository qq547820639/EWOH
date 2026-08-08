# Tasks — Command Map 智能调度驾驶舱升级

> 目标：收敛四个 P0 缺口（统一 ResourceState / ResourcePool 收敛 / Dispatch 原子预占 / 前端 SSE）并补齐三个 P1 项（Priority ProductionImpact / Solver 可见性 / 调度反馈）。改动聚焦 `ewoh-spark-app`，复用而非重写现有 Scheduler V2。

## 依赖与定位
先读下列文件确认现状（已在前序分析核实）：
- `server/modules/scheduler/resource-projection.service.ts`（reservations 空、无 availability/current task/shift）
- `server/modules/scheduler/resource-reservation.service.ts`（既有 CAS/唯一约束）
- `server/modules/scheduler/dispatch-coordinator.service.ts`（只预占 person+device）
- `server/modules/scheduler/resource-reservation.service.ts` 与 schema 的 reservation 表
- `server/modules/scheduler/priority-engine.ts`（已含 base/deadline/waiting/severity/downstream/boost）
- `server/modules/scheduler/scheduler-stream.service.ts`（后端 SSE 已支持 lastEventId/replay/gap/resync）
- `server/modules/scheduler/scheduler-metrics.service.ts`（仅计数器）
- `client/src/pages/CommandMap/panels/ResourcePoolPanel.tsx`、`SchedulePanel.tsx`、`client/src/api/scheduler.ts`
- `shared/api.interface.ts`、`server/database/schema.ts`

- [x] Task 1: 统一 Resource State（ResourceStateAggregator）
  - [x] 1.1 在 `resource-projection.service.ts` 水合 reservations（从 reservation 服务/表），聚合成 availability windows。
  - [x] 1.2 增加 `currentTask`、`shift/team`、`updatedAt`、`freshness` 字段（底层表有则真实读取，无则 null/保持可选，不伪造）。
  - [x] 1.3 导出/收敛为 `ResourceStateAggregator` 统一入口，供地图/ResourcePool/Scheduler/Dispatch 消费。
  - [x] 1.4 新增 resource state 投影单测：reservation 水合、availability window、freshness。
  - 验证：`npx tsc --noEmit` + 新增单测通过。

- [x] Task 2: Dispatch 原子预占扩展（station / tool / vehicle）
  - [x] 2.1 `DispatchCoordinator` 在事务 preflight 阶段追加 station 预占（assignment.stationId），assignment 指定 tool/vehicle 时一并预占。
  - [x] 2.2 `resource-reservation.service.ts` 支持 station 类型；任一预占失败整次回滚。
  - [x] 2.3 新增 DB migration：station（及 tool/vehicle）reservation 的唯一/排他约束，防并发 double booking。
  - [x] 2.4 并发测试：两个 plan 并发 dispatch 抢占同一 station，仅一个成功，另一个返回 `RESOURCE_CONFLICT`，DB 无重叠 reservation。
  - 验证：`dispatch-integration.spec.ts` 或新增并发用例通过。

- [x] Task 3: ResourcePool 收敛到 Scheduler（constraint + replan）
  - [x] 3.1 后端新增/复用 `POST /plans/:planId/constraints`（或等价）用于提交 LOCKED_* / EXCLUDED_RESOURCE / MANUAL_PRIORITY_BOOST / PREFERRED_RESOURCE 后触发 replan。
  - [x] 3.2 `ResourcePoolPanel` 把人工分配/排除/锁定转换为 SchedulingConstraint，调用 replan 而非 `allocateResources`。
  - [x] 3.3 `allocateResources` 调用标记 deprecated（兼容/gamification），不再作为正式调度写路径。
  - 验证：前端拖拽锁定 → 生成 LOCKED_PERSON → replan 的集成用例。

- [x] Task 4: 前端 Scheduler SSE（useSchedulerStream）
  - [x] 4.1 新增 `client/src/hooks/useSchedulerStream.ts`：连接 `GET /api/scheduler/v2/stream`，管理 lastEventId、reconnect、gap→resync、polling fallback、更新 React Query cache。
  - [x] 4.2 `client/src/api/scheduler.ts` 补充 getRun/getPlan/active plans 查询与 React Query keys。
  - [x] 4.3 `SchedulePanel` 改为服务端权威 plan：刷新/深链（planId/runId）从服务端恢复，不再仅依赖 useState。
  - 验证：SSE 断线重连、重复事件去重、缺口 resync 的测试；刷新后恢复 active plan。

- [x] Task 5: PriorityEngine 增加 ProductionImpact
  - [x] 5.1 在 `priority-engine.ts` 增加 `ProductionImpact` 因子（输入含 productionImpact 字段），并入 score/explanation/factors；返回结构不变。
  - [x] 5.2 更新 `priority-engine.spec.ts` 覆盖 ProductionImpact，确保 critical/safety 不走 score 抵消。
  - 验证：priority-engine 单测通过。

- [x] Task 6: 候选资源接口 + Solver 可见性
  - [x] 6.1 新增 `GET /api/scheduler/tasks/:id/candidates`：返回 eligible person/device/station、ETA/distance、skill match、workload/battery、reservation conflict、score、排除原因；复用现有 Eligibility + route cost，不复制规则。
  - [x] 6.2 确认/暴露 solver health、solverVersion、runtime、fallbackReason、objective breakdown（在 plan/response 中可见，UI 显示 OPTIMAL/FEASIBLE/HEURISTIC/FALLBACK/TIMEOUT/UNAVAILABLE）。
  - 验证：candidates 接口集成测试 + solver 可见性断言。

- [x] Task 7: 调度反馈指标（planned vs actual）
  - [x] 7.1 新增 `SchedulingFeedback` 数据模型 + migration（planned/actual start/end/travel/wait/resource、replanCount、conflictCount 等）。
  - [x] 7.2 在 dispatch/task 完成/override 时记录反馈；`scheduler-metrics` 输出 KPI（acceptanceRate/overrideRate/fallbackRate/solverRuntime）。
  - [x] 7.3 仅离线评估与回归，不自动修改生产调度规则。
  - 验证：metrics 单测 + 集成记录用例（`scheduling-feedback.spec.ts`）。

- [x] Task 8: Command Map 驾驶舱 UI 层
  - [x] 8.1 优先级层：未派任务、effective priority、deadline risk、safety flag、waiting（点击展示 factors/explanation）。
  - [x] 8.2 资源可用性层：available/busy/reserved/unavailable/offline/fault/stale + current task/load/battery/location。
  - [x] 8.3 候选高亮：选中任务后调用 candidates 接口高亮候选并展示匹配/排除理由。
  - [x] 8.4 冲突层 + plan delta（before/after、变更 assignment、locked）+ 执行偏差（planned vs actual）。
  - 验证：前端构建 + 手测/组件测试。

- [x] Task 9: 测试与回归
  - [x] 9.1 新增/扩充：ResourceState 投影、station 并发预占、LS‑SSE 重连/resync、candidates、feedback 记录。
  - [x] 9.2 运行 `npm test`、`npx tsc --noEmit`、lint、build，确保既有 719+ 测试不退化。
  - [x] 9.3 排除调试残留文件，提交并推送 origin/main（项目约定）。

# Task Dependencies
- [Task 1] 无依赖（最先）。
- [Task 2] 依赖 [Task 1]（reservation 数据源）。
- [Task 3] 依赖 [Task 1]、[Task 2]（资源状态 + 后端约束接口）。
- [Task 4] 依赖 [Task 1]（SSE 事件需资源状态）；并行于 [Task 3]。
- [Task 5] 无依赖；并行。
- [Task 6] 依赖 [Task 1]、[Task 5]。
- [Task 7] 依赖 [Task 1]、[Task 2]。
- [Task 8] 依赖 [Task 3]、[Task 4]、[Task 6]。
- [Task 9] 依赖全部。