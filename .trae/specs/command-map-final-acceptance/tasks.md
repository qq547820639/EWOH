# Tasks — Command Map 最终验收收敛（command-map-final-acceptance）

> 原则：先核验现状 → 改代码 → 补测试 → 回归。本轮只收敛 3 个经代码确认的剩余增量（selection 单一 owner、maxChangedAssignments、realtime 指标），其余文档内容已在 main 交付，不重复实现。

- [ ] Task 1: Command Map selection 单一 owner（P0-3 补完）
  - [ ] 1.1 核验 `useCommandMapSchedulerState` 的 `ui: CommandMapUIState` 现有读写方式与暴露 API（readme：`setUi`/update helper 是否已暴露）。
  - [ ] 1.2 `CommandMap.tsx`：移除本地 `useState(selectedTaskId)`/`useState(activePlan)` 双轨，统一从 hook 的 `ui` state 读写；`activePlan` 由 `ui.selectedPlanId` 在 plans 中解析（`selectPlanForLayer` 语义，禁止回退 plans[0]）；candidates 查询、map 层、各面板传参全部改走统一 state。
  - [ ] 1.3 `SchedulePanel.tsx`：移除本地 `selectedPlanId` useState，改为受控组件（props `selectedPlanId` + `onSelectedPlanChange`），内部保留 approve/reject/compare 等纯 UI 交互态；确认 `onSelectPlan` 上抛路径与受控化后的行为一致。
  - [ ] 1.4 核对刷新/深链恢复（现有 queryState 机制）与 demo 模式不回归。
  - [ ] 1.5 新增/更新测试：面板选择方案 → 统一 state 更新且地图层同步；地图选择任务 → 统一 state 更新；刷新恢复同一选中；SchedulePanel 不再持有独立 selectedPlanId。
  - [ ] 验证：`npx tsc --noEmit`（client）+ `npx jest --config client/jest.config.cjs --runInBand`（schedule-panel / use-command-map-scheduler-state / scheduler-layers-select 等）全绿。

- [ ] Task 2: Replan maxChangedAssignments 转人工审批（P1 增量）
  - [ ] 2.1 `shared/scheduler.ts`：`ReplanConfig` 新增 `maxChangedAssignments?: number`（缺省 20，注释说明"候选方案相对基线改派数上限，超限转人工审批"）。
  - [ ] 2.2 `plan.service.ts decideReplanApproval`：新增维度——候选方案相对基线 changed assignment 数（复用 `PlanCompareService.compare` 的 changed/added/removed，或等价轻量 diff）> `maxChangedAssignments` → 命中 reason=`max_changed_assignments`，decision=HUMAN_APPROVAL_REQUIRED；未超限维持原判定（critical/lock/ratio 维度语义不变）。
  - [ ] 2.3 确认 replan-preview 返回的 approval decision 同步携带该维度（如 preview 已带 approval 则沿用，不重复计算）。
  - [ ] 2.4 新增测试：changed 数超限 → HUMAN_APPROVAL_REQUIRED（含 reason）；未超限 → 按既有规则；未配置字段 → 缺省 20 生效；既有 replan-preview/replan-stability 不退化。
  - [ ] 验证：`npx jest modules/scheduler`（plan/replan-preview/replan-stability 相关 spec）全绿 + `npx tsc --noEmit`（server）。

- [ ] Task 3: Realtime 可观测指标（P2 增量）
  - [ ] 3.1 `scheduler-metrics.service.ts`：新增 `recordNotifyWakeup()`、`recordPollFallback()`、`recordListenerReconnect()`、`recordResync()`（counter + renderMetrics 输出）。
  - [ ] 3.2 `scheduler-stream.service.ts` 埋点：通知驱动 poll → NotifyWakeup；listener 订阅失败/未启用走轮询 → PollFallback；gap→resync → Resync。
  - [ ] 3.3 `pg-notify.listener.ts` 埋点：断线重连 → ListenerReconnect。
  - [ ] 3.4 新增测试：metrics 计数器断言（snapshot/renderMetrics）；wakeup spec 断言通知驱动与兜底路径的埋点。
  - [ ] 验证：`scheduler-metrics.spec.ts` + `scheduler-stream-wakeup.spec.ts` 全绿。

- [ ] Task 4: 回归 + 契约 + 提交
  - [ ] 4.1 全量回归：scheduler jest + 客户端 jest + `tsc --noEmit`（server/client）+ 改动文件 eslint。
  - [ ] 4.2 契约/OpenAPI：`ReplanConfig.maxChangedAssignments` 为纯 TS 可选字段，确认 `openapi:no-drift` 不需重新生成。
  - [ ] 4.3 排除调试残留与用户未提交改动（`update-readme-latest/*`），提交并推送 `main`。

# Task Dependencies
- [Task 1] 无依赖（前端 selection 收敛，可先行）。
- [Task 2] 无依赖（后端 replan approval）；并行于 [Task 1]。
- [Task 3] 依赖 [Task 2] 无关（metrics 独立模块）；并行于 [Task 1/2]。
- [Task 4] 依赖全部。
