# [scheduler-phase1-constraint-compiler] 统一约束 IR 编译器 Spec

## Why

Phase 0 已把 heuristic 与 CP-SAT 的 HARD 约束语义对齐，但当前约束仍以「字符串 union（`shared/scheduler.ts`）+ 散落在 `eligibility.service.ts` / `heuristic-scheduling-solver.ts` / `cp-sat-scheduling-solver.ts` 的 if/else」表达，双求解器一致性依赖一份**手工语义矩阵**（phase-0 报告 §5）而非机器强制。Phase 0 实测曾因「契约失配 → Python TypeError → CP-SAT 生产恒回退」。本规格引入统一 `SchedulingConstraintIR` 与纯函数编译器，把约束语义收敛为单一事实源，并用机器可执行的 parity 测试矩阵替代手工矩阵，防止双求解器未来再次漂移。

## What Changes

- 新增 `SchedulingConstraintIR` 类型（`shared/scheduler.ts`）：归一化约束表示（`id/type/hardness/scope/params/penalty/source/reasonCode`）。
- 新增纯函数编译器 `constraint-compiler.ts`（`server/modules/scheduler/`）：
  - `classifyHardness(type)`：复用 `constraints.ts` 的 `SUPPORTED_HARD_CONSTRAINTS` / `SUPPORTED_SOFT_CONSTRAINTS`，输出 `HARD | SOFT`。
  - `compileConstraints(constraints, ctx)`：将 `SchedulingConstraint[]` 归一化为 `SchedulingConstraintIR[]`，覆盖 8 条 parity 关键约束（REQUIRED_SKILL ALL/ANY、REQUIRED_CERTIFICATION、SAFETY_BLOCK、PREDECESSOR、STATION_CAPACITY、mustFinishBy 硬、due 软）。
- 新增 parity 测试矩阵 `constraint-parity.spec.ts`：以数据驱动方式逐条断言编译结果 + 与 `eligibility.service.ts` 的 `reason` key、双求解器语义一致。
- **接入求解运行路径（additive，行为不变）**：在求解 run 编排处调用 `compileConstraints`，把 IR 挂到方案的 `DecisionTrace`（可审计/可解释），不改动任何求解器决策逻辑。
- **不引入 BREAKING 变更**：不修改 OpenAPI、状态机、DB 迁移语义；求解器内部逻辑保持现状。

## Impact

- 影响规格：Scheduler 约束语义单一事实源（Phase 1 §5 手工矩阵 → 机器化）。
- 影响代码：`shared/scheduler.ts`（新增类型）、`server/modules/scheduler/constraint-compiler.ts`（新增）、`server/modules/scheduler/__tests__/constraint-parity.spec.ts`（新增）、求解 run 编排处（挂 IR 到 DecisionTrace，additive）。
- 影响契约：无（不修改任何冻结契约语义）。

## 边界（不可违反）

1. 行为不变：编译器是**归一化/审计层**，不改变 heuristic/CP-SAT 的任何决策结果；求解器仍用现有逻辑。
2. 不修改 OpenAPI、状态机、DB 迁移 SQL 语义。
3. 不伪造：IR 仅表示求解器**真实执行**的约束语义，不把 UNSUPPORTED 约束标为已执行（复用 `determineUnsupported` 语义）。
4. 所有改动需通过 scheduler jest 套件、`tsc -b --force`、`openapi:no-drift`。

## ADDED Requirements

### Requirement: 统一约束 IR 类型
系统 SHALL 提供 `SchedulingConstraintIR` 类型，归一化表示一条约束的 `id/type/hardness/scope/params/penalty/source/reasonCode`，其中 `hardness` 由 `SUPPORTED_HARD_CONSTRAINTS` / `SUPPORTED_SOFT_CONSTRAINTS` 唯一确定。

#### Scenario: 类型唯一事实源
- **WHEN** 需要判定某约束是硬还是软
- **THEN** 结果由 `classifyHardness` 从 SUPPORTED 集合推导，而非在各求解器重复 if/else。

### Requirement: 约束编译器归一化
系统 SHALL 提供 `compileConstraints` 纯函数，把 `SchedulingConstraint[]` 归一化为 `SchedulingConstraintIR[]`，并覆盖 8 条 parity 关键约束的语义（REQUIRED_SKILL ALL/ANY、REQUIRED_CERTIFICATION、SAFETY_BLOCK、PREDECESSOR、STATION_CAPACITY、mustFinishBy 硬、due 软）。

#### Scenario: REQUIRED_SKILL 语义归一化
- **WHEN** 编译 REQUIRED_SKILL 约束
- **THEN** IR.params 记录 `skillMatchMode`（ALL/ANY，缺省 ALL）与 `requiredSkills`，与 `eligibility.service.ts` 的 `.every/.some` 语义一致。

#### Scenario: mustFinishBy 与 due 分离
- **WHEN** 编译时间截止约束
- **THEN** `mustFinishByMs` 归一化为 HARD（违反则不可分配），`dueMs` 归一化为 SOFT（仅 lateness 罚），与 phase-0 §5 一致。

### Requirement: 双求解器 parity 测试矩阵
系统 SHALL 提供数据驱动的 `constraint-parity.spec.ts`，对 8 条 parity 关键约束逐条断言：编译出的 IR 字段正确，且 IR 语义与 `eligibility.service.ts` 的 reason key、双求解器行为一致。

#### Scenario: 防止双求解器漂移
- **WHEN** 未来某约束在两个求解器间的语义出现分歧
- **THEN** parity 测试矩阵失败，阻断合并。

### Requirement: IR 挂接决策链路（additive）
系统 SHALL 在求解 run 编排处调用 `compileConstraints`，把编译出的 IR 挂到方案 `DecisionTrace`（审计/解释），且不改动求解器决策。

#### Scenario: 可审计约束语义
- **WHEN** 生成一个调度方案
- **THEN** 方案 DecisionTrace 含该 run 的约束 IR，供解释与审计，且求解结果与未接入前一致。

## MODIFIED Requirements

### Requirement: Phase 0 约束语义（保持）
Phase 0 已对齐的 8 条 HARD 语义（REQUIRED_SKILL ALL/ANY、REQUIRED_CERTIFICATION、SAFETY_BLOCK fail-closed、mustFinishBy 硬/due 软、PREDECESSOR、STATION_CAPACITY）保持有效，本规格仅将其固化进 IR + 测试矩阵，不改变语义。

## REMOVED Requirements

### Requirement: 无
**Reason**: 无移除项。
**Migration**: 无。
