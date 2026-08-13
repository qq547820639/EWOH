# [scheduler-phase2-objective-lexicographic] CP-SAT objective 分层（lexicographic）Spec

## Why

当前 [solver.py](file:///Volumes/Extra/CodeProj/EWOH/src/edge_platform/scheduler/cpsat/solver.py#L415-L477) 的目标函数是**扁平加权和**：`objective = unassignedPenalty·Σmissed + Σ(软目标项)`，其中 `unassignedPenalty=1000` 是魔法数。当软目标（travel 距离、lateness、churn 等）在多任务下累加超过该魔法数时，求解器会「诚实地」选择漏派工来降低软成本——这是正确性风险。phase-0 报告 §18 要求「full objective 分层（SAFETY_BLOCK 恒 Level 0）」。本规格把目标改为**字典序分层**：Level 0（未分配覆盖）严格支配所有软目标，使「优先派满、再优化软目标」成为结构性保证而非魔法数。

## What Changes

- 新增纯 Python 模块 `objective.py`（`src/edge_platform/scheduler/cpsat/`）：
  - `OBJECTIVE_LEVELS`：显式分层常量（Level 0=未分配覆盖；Level 1=lateness；Level 2=station wait；Level 3=travel；Level 4=churn；Level 5-8 预留 workload/energy/risk 等）。SAFETY_BLOCK/容量/no-overlap 等为硬约束，属可行性层（恒 Level 0，不在目标内）。
  - `compute_unassigned_scale(request) -> int`：从请求实际边界计算一个整数 scale，使 `scale·Σmissed` 严格支配 `Σ软目标`（soft_upper_bound + 1），且夹在安全区间内不溢出 int64。
- 修改 `solver.py` 目标构造：把「`unassignedPenalty·missed` + 软项扁平求和」改为「`unassignedScale·missed` + 软项求和」，其中 `unassignedScale = compute_unassigned_scale(request)`（替代魔法数 1000）。
- 契约 `contract.py`：保留 `SolverWeights.unassignedPenalty` 兼容字段，但目标构造不再依赖它作为唯一支配手段（改由 scale 保证）；响应 `objectiveBreakdown` 增加 `unassigned` 项（透传真实未分配贡献）。
- 新增回归测试：纯 Python（无需 ortools）验证 `compute_unassigned_scale` 的支配性与边界。
- **不引入 BREAKING 变更**：不改 Nest `shared/api.interface.ts` 的 `SolverRequest` 结构；`SolverWeights.unassignedPenalty` 保留向后兼容；不改 OpenAPI/状态机/DB 迁移。

## Impact

- 影响规格：CP-SAT 求解目标语义（软目标分层）。
- 影响代码：`src/edge_platform/scheduler/cpsat/objective.py`（新增）、`solver.py`（目标构造）、`contract.py`（`objectiveBreakdown` 增项）、`tests/test_objective_lexicographic.py`（新增）。
- 影响契约：无（不改任何冻结契约语义；仅 worker 内部目标构造 + 响应 breakdown 增项）。

## 边界（不可违反）

1. SAFETY_BLOCK、容量、no-overlap、禁入区、技能/证书等硬约束保持硬约束语义（可行性层），不进目标。
2. 只改目标构造的「未分配支配」部分；各软目标项的相对权重（lateness/travel/churn 等）语义不变。
3. `compute_unassigned_scale` 必须返回 int 且保证 `scale > 任何可能软目标之和`，不溢出 CP-SAT int64。
4. 不改 Nest 侧 SolverRequest 契约、OpenAPI、状态机、DB 迁移。
5. Python 改动通过 pytest（contract 套件 + 新增测试）；Nest 侧 `openapi:no-drift` 与 scheduler jest 不回归。

## ADDED Requirements

### Requirement: 字典序目标（未分配严格支配）
系统 SHALL 使 CP-SAT 目标函数中「未分配任务数」严格支配所有软目标项，保证求解器优先最小化漏派工，再优化软目标。

#### Scenario: 软成本不吞未分配
- **WHEN** 某任务若派工会产生较大软成本（travel/lateness/churn），且这些软成本之和超过旧的 `unassignedPenalty`
- **THEN** 求解器仍优先派工（未分配数不变），而非为省软成本漏派工。

### Requirement: 分层常量与安全 scale
系统 SHALL 提供 `OBJECTIVE_LEVELS` 分层常量与 `compute_unassigned_scale`，返回一个基于请求实际边界的、严格支配软目标之和且不溢出的整数 scale。

#### Scenario: scale 严格支配
- **WHEN** 给定任意请求（含候选成本矩阵、任务数、horizon、权重）
- **THEN** `compute_unassigned_scale(request) > soft_upper_bound(request)`。

## MODIFIED Requirements

### Requirement: 软目标权重（保持）
lateness / stationWait / travel / churn 等软目标项的权重方向与取值语义保持；仅目标构造从「扁平求和」升级为「未分配支配 + 软项求和」。

## REMOVED Requirements

### Requirement: 无
**Reason**: 无移除项。
**Migration**: 无。
