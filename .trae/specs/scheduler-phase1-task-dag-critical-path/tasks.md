# Tasks — Scheduler Phase 1 任务 DAG 传递阻塞闭包

> 原则：先核验现状 → 新增 task-dag 纯函数 → 接入 priority-engine → 补回归测试 → 回归。行为语义精确、改动最小。

- [x] Task 1: 新增纯函数模块 `task-dag.ts`
  - [x] 1.1 `computeBlockingReach(tasks)`：从 `predecessorIds` 构建反向邻接（前驱 → 后继），DFS + 记忆化 + 访问中守卫，返回 `Map<taskId, transitiveDescendantCount>`（去重）。
  - [x] 1.2 环安全：访问中命中返回空集（不无限递归），结果确定且非负。
  - [x] 验证：`tsc -b --force` 通过；纯函数无副作用。

- [x] Task 2: 接入 `priority-engine.ts`
  - [x] 2.1 在 `computeEffectivePriorityResults` 中用 `computeBlockingReach` 的传递可达数替换当前的直接 `downstreamCount`（原第 241-246 行）。
  - [x] 2.2 保持 `PriorityEngine.compute` 签名与 `PriorityInput.downstreamCount` 类型不变；无前驱任务仍为 0。
  - [x] 验证：既有 `priority-engine.spec.ts` 不回归。

- [x] Task 3: 新增 `task-dag.spec.ts` 回归测试
  - [x] 3.1 链 `A→B→C`：可达数 2/1/0。
  - [x] 3.2 菱形 `A→B、A→C、B→D、C→D`：A=3、B=1、C=1、D=0。
  - [x] 3.3 环 `A↔B`：不无限递归、结果确定非负。
  - [x] 3.4 无依赖：全部 0。
  - [x] 验证：新增测试套件 5 用例全绿。

- [x] Task 4: 回归 + 契约 + 提交
  - [x] 4.1 scheduler jest 全量 94 套件/736 tests；`tsc -b --force` 0 错误；`npm run openapi:no-drift` 通过。
  - [x] 4.2 eslint 对改动文件 0 输出。
  - [x] 4.3 提交并推送 `main`。

# Task Dependencies

- [Task 2] 依赖 [Task 1]。
- [Task 3] 依赖 [Task 1]（可与 Task 2 并行）。
- [Task 4] 依赖全部。
