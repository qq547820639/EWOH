# Tasks

> 目标：修复 CP-SAT Adapter 数据保真、约束透传、优先级统一、技能 ALL/ANY 显式化，达成 solver parity。改动聚焦 `ewoh-spark-app`，不进行无关重构。

## 依赖与定位
先读以下文件确认现状再改：
- `shared/api.interface.ts`（SolverRequest / WorldStateSnapshot / SchedulingConstraint）
- `server/modules/scheduler/world-state.service.ts`（快照构建）
- `server/modules/scheduler/eligibility.service.ts`
- `server/modules/scheduler/priority-engine.ts`
- `server/modules/scheduler/constraints.ts`（约束类型）
- `server/modules/scheduler/__tests__/cp-sat-fallback.spec.ts`（既有测试）

- [x] Task 1: 扩展共享类型 `shared/api.interface.ts`
  - [x] 1.1 `SolverRequest.tasks[*]` 增加 `skillMatchMode?: 'ALL' | 'ANY'` 与 `effectivePriorityScore?: number`。
  - [x] 1.2 `WorldStateSnapshot.tasks[*]` 增加 `safetyCritical?: boolean; preemptible?: boolean; skillMatchMode?: 'ALL' | 'ANY'; dueAtMs?: number | null;`。
  - [x] 1.3 `WorldStateSnapshot.devices[*]` 增加 `x?: number; y?: number; locationStationId?: string | null; availableWindows?: Array<{startMs:number; endMs:number}>;`。
  - [x] 1.4 `WorldStateSnapshot.stations[*]` 增加 `capacity?: number | null;`。
  - 验证：`npx tsc --noEmit`（在 ewoh-spark-app 下）通过。

- [x] Task 2: `world-state.service.ts` 真实透传
  - [x] 2.1 快照 task 透传 `safetyCritical / preemptible / skillMatchMode / dueAtMs`（从 DB/源数据读取，缺失用业务默认值，不使用假占位）。
  - [x] 2.2 快照 device 透传 `x / y / locationStationId / availableWindows`。
  - [x] 2.3 快照 station 透传 `capacity`。
  - 验证：新增/更新快照构建单测断言字段真实值。

- [x] Task 3: `cp-sat-scheduling-solver.ts` 数据保真
  - [x] 3.1 `task.safetyCritical` / `preemptible` 用真实值替换 `false` 占位。
  - [x] 3.2 `person.availableFromMs` 用真实可用时间（无则保留 null，但不得虚构）。
  - [x] 3.3 `device.x / y` 用真实位置替换 `0`，`device.availableFromMs` 用真实值。
  - [x] 3.4 `station.capacity` 用真实值替换 `1`。
  - 验证：unit 测试断言请求字段真实值。

- [x] Task 4: `cp-sat-scheduling-solver.ts` 约束透传
  - [x] 4.1 将 `SchedulingConstraint[]` 映射进 `SolverRequest`：hard 约束映射到 `frozenAssignments / forbiddenZones / reservations`，其余（LOCKED_* / RESOURCE_AVAILABLE_WINDOW / MIN_BATTERY / MAX_WORKLOAD / FORBIDDEN_RESOURCE / PREFERRED_RESOURCE）新增 `constraints` 透传字段（或复用既有字段）。
  - [x] 4.2 `_constraints` 参数改为实际使用；不支持的约束显式标记 unsupported，不静默忽略。
  - 验证：测试断言 LOCKED_PERSON 约束进入 CP-SAT 请求。

- [x] Task 5: `cp-sat-scheduling-solver.ts` 统一优先级
  - [x] 5.1 注入/复用共享 `PriorityEngine`，在 `buildRequest` 中计算 `effectivePriorityScore` 供 CP-SAT 消费。
  - [x] 5.2 移除静态 `priorityRank` 分叉（或让 CP-SAT 的 `priority` 字段来自统一计算结果）。
  - 验证：测试断言 CP-SAT 请求优先级与 `PriorityEngine.compute` 结果一致。

- [x] Task 6: `eligibility.service.ts` 技能 ALL/ANY 显式化
  - [x] 6.1 读取 task `skillMatchMode`：`ALL` ⇒ `.every()`，`ANY` ⇒ `.some()`；缺省默认 `ALL`。
  - [x] 6.2 移除硬编码 `.some()`，用显式分支。
  - 验证：新增 ALL / ANY 两个测试场景通过。

- [x] Task 7: 测试与回归
  - [x] 7.1 新增/扩充 `cp-sat-fallback.spec.ts`：数据保真、约束透传、优先级一致、skill ALL/ANY、fallback 后 LOCKED 不丢。
  - [x] 7.2 运行 `npm test`（scheduler 相关）与 `npx tsc --noEmit`、lint，确保既有 646+ 测试不退化。
  - [x] 7.3 排除调试残留文件，提交并推送 origin/main（遵循项目约定）。

# Task Dependencies
- [Task 1] 无依赖（最先）。
- [Task 2] 依赖 [Task 1]。
- [Task 3] 依赖 [Task 1]、[Task 2]。
- [Task 4] 依赖 [Task 1]、[Task 3]。
- [Task 5] 依赖 [Task 1]、[Task 3]。
- [Task 6] 依赖 [Task 1]。
- [Task 7] 依赖 [Task 2-6]。