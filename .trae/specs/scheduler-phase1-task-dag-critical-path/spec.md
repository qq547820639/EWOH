# [scheduler-phase1-task-dag-critical-path] 任务 DAG 传递阻塞闭包 Spec

## Why

`computeEffectivePriorityResults` 的 `downstreamCount` 当前仅统计**直接**反向阻塞计数（对每个 `predecessorIds` 项 +1，见 [priority-engine.ts](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/server/modules/scheduler/priority-engine.ts#L241-L246)），只反映 1 跳依赖。这会把「直接阻塞 2 个叶子任务」误判为比「直接阻塞 1 个、但该任务传递阻塞一整条 10 任务链」更紧急，低估了长链头部的关键性。phase-0 报告 §18 明确要求「Task DAG 从 direct downstream 升级为完整 critical path」。本规格把下游阻塞从直接计数升级为**传递闭包阻塞可达数**，并保证环安全、确定性、可解释。

## What Changes

- 新增纯函数模块 `task-dag.ts`：从 `snapshot.tasks[].predecessorIds` 构建 DAG，计算每个任务的**传递下游可达数**（transitive descendant count），DFS + 记忆化 + 访问中守卫（环安全、无无限递归、确定性）。
- 修改 `priority-engine.ts` 的 `computeEffectivePriorityResults`：用 `task-dag.ts` 的传递可达数替换当前的直接 `downstreamCount`，继续喂给 `downstream_blocking` 因子（语义不变：下游越多越紧急，但现在是传递语义）。
- 新增 `task-dag.spec.ts` 回归测试：链、菱形、多前驱、环、无依赖等形态。
- **不引入 BREAKING 变更**：不改 `PriorityEngine.compute` 签名、`PriorityInput.downstreamCount` 类型、OpenAPI/状态机/DB 迁移语义；无前驱任务仍为 0（既有测试不回归）。

## Impact

- 影响规格：调度优先级引擎（下游阻塞因子从直接计数升级为传递闭包）。
- 影响代码：`server/modules/scheduler/task-dag.ts`（新增）、`server/modules/scheduler/priority-engine.ts`（替换下游计数）、新增 `__tests__/task-dag.spec.ts`。
- 影响契约：无（不改任何冻结契约语义）。

## 边界（不可违反）

1. 只升级下游阻塞计数为传递闭包；优先级其余因子（base/deadline/waiting/production/event/manual_boost）语义不变。
2. 环安全：依赖环不导致无限递归或非确定性；环内任务保守计入（确定性、可解释）。
3. 不改 `PriorityEngine.compute` / `computeEffectivePriorityScores` 对外签名；无前驱任务仍得到 0 下游阻塞。
4. 不修改 OpenAPI、状态机、DB 迁移 SQL。
5. 所有改动需通过 scheduler jest 套件、`tsc -b --force`、`openapi:no-drift`。

## ADDED Requirements

### Requirement: 传递下游阻塞可达数
系统 SHALL 提供纯函数 `computeBlockingReach(tasks)`，从 `predecessorIds` 构建 DAG 并返回每个任务的传递下游可达数（该任务直接或间接阻塞的任务总数），DFS 记忆化且环安全。

#### Scenario: 链
- **WHEN** 依赖链 `A → B → C`（A 是 B 的前驱，B 是 C 的前驱）
- **THEN** `A` 可达数=2、`B`=1、`C`=0。

#### Scenario: 菱形
- **WHEN** `A → B`、`A → C`、`B → D`、`C → D`
- **THEN** `A` 可达数=3（B、C、D）、`B`=1、`C`=1、`D`=0。

#### Scenario: 环
- **WHEN** 依赖存在环（如 `A ↔ B`）
- **THEN** 不无限递归、结果确定且非负（访问中守卫兜底）。

### Requirement: 下游阻塞因子接入传递语义
系统 SHALL 使 `computeEffectivePriorityResults` 用传递下游可达数替换直接计数，喂给 `downstream_blocking` 因子，使长链头部任务更紧急。

#### Scenario: 长链头部优先
- **WHEN** 任务 X 直接阻塞 2 个叶子、任务 Y 直接阻塞 1 个但传递阻塞一整条链
- **THEN** Y 的下游阻塞因子值大于 X（Y 更紧急）。

## MODIFIED Requirements

### Requirement: 下游阻塞因子（保持方向）
`downstream_blocking` 因子「下游越多越紧急」（负项缩小 score）的方向与权重语义保持；仅将 `value` 从直接计数升级为传递可达数。

## REMOVED Requirements

### Requirement: 无
**Reason**: 无移除项。
**Migration**: 无。
