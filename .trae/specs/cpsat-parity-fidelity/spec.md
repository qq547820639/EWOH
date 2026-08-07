# CP-SAT Adapter 数据保真与启发式求解器同位(Solver Parity) Spec

## Why

前期智能调度闭环已基本完成，但针对"指挥地图智能调度"升级规范的十八条要求逐条核验后，发现在 **CP-SAT 与启发式求解器的数据保真度和约束语义一致性** 上仍存在合规缺口，且共享契约已预留了对应字段（`SolverRequest.safetyCritical / preemptible / availableFromMs / capacity`），只是 CP-SAT Adapter 未真正填充。这些缺口违反规范"十五、关键安全与架构约束"第 11 条（CP-SAT 与 heuristic 必须保持 hard constraint 语义一致）与"二、已经发现的重点问题"第 1-4 条。

## Verified Gaps（代码实测）

1. **CP-SAT 输入占位值**（`cp-sat-scheduling-solver.ts#buildRequest`）：
   - `task.safetyCritical: false`、`task.preemptible: false` 硬编码占位（第 125-126 行）。
   - `person.availableFromMs: null`（第 140 行）。
   - `device.x: 0, y: 0`、`device.availableFromMs: null`（第 149-151 行）。
   - `station.capacity: 1`（第 158 行）。
   - 成因：`WorldStateSnapshot.tasks` 尚无 `safetyCritical/preemptible/skillMatchMode`，`snapshot.devices` 尚无 x/y 位置，`snapshot.stations` 无真实 capacity。

2. **CP-SAT 忽略约束**（`cp-sat-scheduling-solver.ts#buildRequest`，第 95-97 行）：参数 `_constraints` 未使用，`SchedulingConstraint[]` 未映射进 `SolverRequest`。fallback 时虽经启发式求解器消费约束，但 CP-SAT 主路径完全丢失约束（LOCKED_* / FORBIDDEN_* / RESOURCE_AVAILABLE_WINDOW / MIN_BATTERY / MAX_WORKLOAD 等）。

3. **优先级规则分叉**：启发式（`heuristic-scheduling-solver.ts` 第 209 行）使用共享 `PriorityEngine.compute`；CP-SAT（`cp-sat-scheduling-solver.ts` 第 115 行）使用各自独立的静态 `priorityRank(t.priority)`。违反"十四?三、PriorityEngine 需要统一"。

4. **技能匹配语义隐晦**（`eligibility.service.ts` 第 84 行）：使用 `.some()` 而未显式声明 `skillMatchMode: 'ALL' | 'ANY'`，业务规则藏在具体实现里。

## What Changes

- `shared/api.interface.ts`（**BREAKING** 类型扩展，向后兼容 optional）：
  - `SolverRequest.tasks[*]` 增加 `skillMatchMode?: 'ALL' | 'ANY'`。
  - `WorldStateSnapshot.tasks[*]` 增加 `safetyCritical?: boolean; preemptible?: boolean; skillMatchMode?: 'ALL' | 'ANY'; effectivePriorityScore?: number; dueAtMs?: number | null;`。
  - `WorldStateSnapshot.devices[*]` 增加 `x?: number; y?: number; locationStationId?: string | null; availableWindows?: Array<{startMs:number; endMs:number}>;`。
  - `WorldStateSnapshot.stations[*]` 增加 `capacity?: number | null;`。
  - （可选）`SolverRequest.task` 增加 `effectivePriority: number` 用于 CP-SAT 消费统一优先级。
- `server/modules/scheduler/world-state.service.ts`：快照构建时透传 task 的 `safetyCritical/preemptible/skillMatchMode`、device 位置、station capacity。
- `server/modules/scheduler/cp-sat-scheduling-solver.ts`：
  - 填充真实数据替换占位值。
  - 将 `SchedulingConstraint[]` 映射进 `SolverRequest`（hard 约束 → `frozenAssignments/forbiddenZones/reservations` 或新增 `constraints` 透传），不再忽略。
  - 用共享 `PriorityEngine` 计算 `effectivePriorityScore` 供 CP-SAT 消费，移除静态 `priorityRank`。
- `server/modules/scheduler/eligibility.service.ts`：显式 `skillMatchMode` 语义（ALL ⇒ `.every()`，ANY ⇒ `.some()`），从 task 数据读取，不再硬编码 `.some()`。
- `server/modules/scheduler/eligibility.service.ts` / `scheduling-problem`：若存在独立 `skillMatchMode` 来源，统一读取。
- 测试：`server/modules/scheduler/__tests__/cp-sat-fallback.spec.ts` 扩充，新增 parity / fidelity / constraint 透传 / skill ALL-ANY 测试。

## Impact

- Affected specs: `Scheduling V2`、`Solver parity`、`PriorityEngine`、`Eligibility`。
- Affected code:
  - `ewoh-spark-app/shared/api.interface.ts`
  - `ewoh-spark-app/server/modules/scheduler/cp-sat-scheduling-solver.ts`
  - `ewoh-spark-app/server/modules/scheduler/world-state.service.ts`
  - `ewoh-spark-app/server/modules/scheduler/eligibility.service.ts`
  - `ewoh-spark-app/server/modules/scheduler/priority-engine.ts`（仅确认导出可复用）
  - `ewoh-spark-app/server/modules/scheduler/__tests__/cp-sat-fallback.spec.ts`
  - 可能：`ewoh-spark-app/server/modules/scheduler/constraints.ts`（constraint 类型 + toSolver 映射）

## ADDED Requirements

### Requirement: CP-SAT Adapter 真实数据保真
系统 SHALL 在 `buildRequest` 中填充真实的 `safetyCritical`、`preemptible`、person/device `availableFromMs`、device `x/y`、station `capacity`，不得使用 `false/0/null/1` 占位。

#### Scenario: 数据保真
- **GIVEN** snapshot 中某 task `safetyCritical=true`、某 device `x=12,y=8`、某 station `capacity=3`
- **THEN** `SolverRequest.tasks[*].safetyCritical===true`、`devices[*].x===12 && y===8`、`stations[*].capacity===3`

### Requirement: 约束透传 CP-SAT
系统 SHALL 将 `SchedulingConstraint[]` 完整映射进 `SolverRequest`，hard 约束在 CP-SAT 主路径生效，不得静默丢弃。

#### Scenario: 约束透传
- **GIVEN** 人工 `LOCKED_PERSON` 约束
- **THEN** CP-SAT 请求包含该锁定，且 CP-SAT 与 heuristic 均不违反该锁定

### Requirement: 统一优先级
系统 SHALL 让 CP-SAT 与 heuristic 消费同一 `PriorityEngine` 的 `effectivePriorityScore`，不得各自实现独立优先级规则。

#### Scenario: 优先级一致
- **GIVEN** 同一 snapshot 与 policy
- **THEN** CP-SAT 请求中任务的优先级排序来自共享 `PriorityEngine`，与 heuristic 语义一致

### Requirement: 技能匹配显式 ALL/ANY
系统 SHALL 暴露 `skillMatchMode: 'ALL' | 'ANY'`，eligibility 依据该字段显式匹配，不得仅靠 `.some()` 隐式实现。

#### Scenario: ALL 语义
- **GIVEN** task `skillMatchMode='ALL'`、`requiredSkills=['a','b']`，person 仅具备 `['a']`
- **THEN** 该 person 不可调度（infeasible）

#### Scenario: ANY 语义
- **GIVEN** task `skillMatchMode='ANY'`、`requiredSkills=['a','b']`，person 具备 `['b']`
- **THEN** 该 person 可调度

## MODIFIED Requirements

### Requirement: Solver fallback 保持约束一致
hard 约束（含 LOCKED_* / FORBIDDEN_* / RESOURCE_AVAILABLE_WINDOW）在 CP-SAT 与 heuristic fallback 两条路径下语义一致。

### Requirement: 数据源准权威
`WorldStateSnapshot` 作为 solver 唯一输入，缺失字段以真实业务状态为准，不虚构占位。

## REMOVED Requirements
无（本次仅新增/修正，不删除既有能力）。