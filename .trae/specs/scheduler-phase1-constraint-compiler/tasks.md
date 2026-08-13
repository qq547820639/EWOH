# Tasks — Scheduler Phase 1 统一约束 IR 编译器

> 原则：先核验现状 → 定义 IR → 实现编译器 → parity 测试矩阵 → 接入 DecisionTrace（additive）→ 回归。行为不变（编译器为归一化/审计层，不改求解器决策）。

- [x] Task 1: 定义 `SchedulingConstraintIR` 类型（`shared/scheduler.ts`）
  - [x] 1.1 新增 `SchedulingConstraintIR`：`id/type/hardness('HARD'|'SOFT')/scope/params/penalty?/source/reasonCode`，其中 `params` 归一化 `skillMatchMode`/`requiredSkills`/`requiredCertifications`/`mustFinishByMs`/`dueMs`/`predIds`/`capacity` 等字段。
  - [x] 1.2 新增 `ConstraintScope`（`person`/`device`/`station`/`task`/`zone`/`global`）与 `ConstraintParams` 辅助类型。
  - [x] 验证：`tsc -b --force` 通过。

- [x] Task 2: 实现纯函数编译器 `constraint-compiler.ts`
  - [x] 2.1 `classifyHardness(type)`：复用 `constraints.ts` 的 `SUPPORTED_HARD_CONSTRAINTS` / `SUPPORTED_SOFT_CONSTRAINTS`（EXCLUDED_RESOURCE 按 hard 优先）。
  - [x] 2.2 `compileConstraints(constraints, ctx)`：归一化 8 条 parity 关键约束 + 其余硬/软约束通用归一化；UNSUPPORTED 标 `reasonCode='UNSUPPORTED_CONSTRAINT'`。
  - [x] 2.3 `reasonCode` 与 `eligibility.service.ts` 的 reason key 对齐。
  - [x] 验证：`tsc -b --force` 通过；纯函数模块无副作用。

- [x] Task 3: parity 测试矩阵 `constraint-parity.spec.ts`
  - [x] 3.1 数据驱动：8 条 parity 关键约束逐条编译 → 断言 IR 字段。
  - [x] 3.2 双求解器语义一致性断言（REQUIRED_SKILL ALL/ANY、mustFinishBy 硬/due 软、STATION_CAPACITY）。
  - [x] 3.3 EXCLUDED_RESOURCE 重分类为 HARD 断言。
  - [x] 验证：`constraint-parity` 14/14 全绿。

- [x] Task 4: 接入求解 run 编排，挂 IR 到 DecisionTrace（additive）
  - [x] 4.1 run 编排处调用 `compileConstraints`，IR 挂到 assignment 的 `decisionTrace.constraintIR`。
  - [x] 4.2 求解结果与接入前一致（行为不变），IR 仅审计/解释。
  - [x] 验证：scheduler 全量回归无回归。

- [x] Task 5: 回归 + 契约 + 提交
  - [x] 5.1 scheduler jest 全量 92 套件/728 tests；`tsc -b --force` 0 错误；`npm run openapi:no-drift` 通过。
  - [x] 5.2 eslint 对改动文件 0 输出。
  - [x] 5.3 提交并推送 `main`。

# Task Dependencies

- [Task 2] 依赖 [Task 1]。
- [Task 3] 依赖 [Task 2]。
- [Task 4] 依赖 [Task 2]（可与 Task 3 并行）。
- [Task 5] 依赖全部。
