# Tasks — Command Map 最终验收收敛（command-map-final-acceptance）

> 原则：先核验现状 → 改代码 → 补测试 → 回归。本轮只收敛 3 个经代码确认的剩余增量（selection 单一 owner、maxChangedAssignments、realtime 指标），其余文档内容已在 main 交付，不重复实现。

- [x] Task 1: Command Map selection 单一 owner（P0-3 补完）
  - [x] 1.1 核验 `useCommandMapSchedulerState` 的 `ui: CommandMapUIState` 现有读写方式与暴露 API（新增 `applyUiPatch` 纯函数 + `updateUi` useCallback，暴露于返回结构）。
  - [x] 1.2 `CommandMap.tsx`：移除本地 `useState(selectedTaskId)`/`useState(activePlan)` 双轨，统一从 hook 的 `ui` state 读写；`activePlan` 由 `ui.selectedPlanId` 在 plans 中解析（`selectPlanForLayer` 语义，禁止回退 plans[0]）；candidates 查询、map 层、各面板传参全部改走统一 state。
  - [x] 1.3 `SchedulePanel.tsx`：移除本地 `selectedPlanId` useState，改为受控组件（props `selectedPlanId` + `onSelectedPlanChange`），内部保留 approve/reject/compare 等纯 UI 交互态；移除上抛 effect 与自动选中首个方案逻辑。
  - [x] 1.4 核对刷新/深链恢复（现有 queryState 机制）与 demo 模式不回归（深链 effect 移除 plans[0] 回退，终态等价）。
  - [x] 1.5 新增/更新测试：`applyUiPatch` describe（面板选方案/地图选任务/清空选中 4 断言）。
  - [x] 验证：client tsc 零新增错误（基线对比 18 条既有错误一致）+ client jest 95 suites/730 tests 全绿（schedule-panel / use-command-map-scheduler-state / scheduler-layers-select 定向 14 tests）。

- [x] Task 2: Replan maxChangedAssignments 转人工审批（P1 增量）
  - [x] 2.1 字段落地：`ReplanApprovalConfig.maxChangedAssignments?: number`（缺省 20，与 autoMaxChurnRatio 同级；说明：该维度在审批判定中消费，放 ReplanApprovalConfig 避免双 config 漂移，属 spec 落地位置微调）。
  - [x] 2.2 `plan.service.ts consultReplanApproval`：新增维度——preview changed+added+removed > `(config.maxChangedAssignments ?? 20)` → reason=`max_changed_assignments`，decision=HUMAN_APPROVAL_REQUIRED；未超限维持原判定（critical/lock/ratio 维度语义不变）。
  - [x] 2.3 确认 replan-preview 返回的 approval decision 同步携带该维度（ReplanPreviewService.buildResult 已真实填充三项计数，未改动）。
  - [x] 2.4 新增测试：replan-preview.service.spec.ts +3（config=5 超限命中 / 等值不命中 / 缺省 20 生效 21 命中 20 不命中）。
  - [x] 验证：`npx jest modules/scheduler`（plan/replan-preview/replan-stability 相关 spec）全绿 + `npx tsc --noEmit -p tsconfig.spec.json` 零错误。

- [x] Task 3: Realtime 可观测指标（P2 增量）
  - [x] 3.1 `scheduler-metrics.service.ts`：新增 `recordNotifyWakeup()`、`recordPollFallback()`、`recordListenerReconnect()`、`recordResync()`（counter + renderMetrics 输出）。
  - [x] 3.2 `scheduler-stream.service.ts` 埋点：通知驱动 poll → NotifyWakeup；listener 未提供/订阅失败轮询兜底 → PollFallback；gap→resync → Resync。
  - [x] 3.3 `pg-notify.listener.ts` 埋点：新增可选 `onReconnect` 回调（退避重连近似计数），`scheduler.module.ts` useFactory 注入 metricsService。
  - [x] 3.4 新增测试：scheduler-metrics.spec.ts + scheduler-stream-wakeup.spec.ts 断言计数器与埋点（净增 8 用例）。
  - [x] 验证：`scheduler-metrics.spec.ts` + `scheduler-stream-wakeup.spec.ts` + `phase2-realtime.spec.ts` 全绿（68 suites/503 tests）。

- [x] Task 4: 回归 + 契约 + 提交
  - [x] 4.1 全量回归：scheduler jest 68 suites/503 tests + 客户端 jest 95 suites/730 tests + `tsc --noEmit -p tsconfig.spec.json` 零错误 + 改动文件 eslint 全绿。
  - [x] 4.2 契约/OpenAPI：`openapi:no-drift` 通过——`maxChangedAssignments` 为纯 TS 可选字段，无需重新生成。
  - [x] 4.3 排除调试残留与用户未提交改动（`update-readme-latest/*`），已提交并推送 `main`（commit 87988a1，19 files，含验收实施包文档与 spec 文档）。

# Task Dependencies
- [Task 1] 无依赖（前端 selection 收敛，可先行）。
- [Task 2] 无依赖（后端 replan approval）；并行于 [Task 1]。
- [Task 3] 无依赖（metrics 独立模块）；并行于 [Task 1/2]。
- [Task 4] 依赖全部。
