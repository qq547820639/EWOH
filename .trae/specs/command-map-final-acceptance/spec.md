# Command Map 最终验收收敛（Final Acceptance Convergence）Spec

> change-id：`command-map-final-acceptance`
> 日期：2026-08-10 ｜ 依据：`EWOH_CommandMap_智能调度_最终验收与实施包.md`（验收/实施包）+ 对当前 main（ced0d89）逐项代码核验
> 前置 spec（已完成并推送）：`scheduler-prod-convergence`（commit 60c7808 + ced0d89，覆盖 required deps、RouteCost 三模式、golden parity、archived README、ReplanStabilityBudget 前两项、standalone_024 LISTEN/NOTIFY）

## Why

用户提交"最终验收与实施包"文档。该文档基于**早于 60c7808 的公开 main 快照**验收，声称多项收敛未落地。经对当前 main（HEAD=ced0d89，已推送 origin/main）逐项代码核验：

- ✅ 已交付：生产依赖 required 化（world-state/solver/dispatch/plan）、RouteCost STRICT/DEGRADED/ADVISORY、TS↔Python golden parity、`ui/command_map/README.md`、`ReplanConfig.freezeWindowMinutes/minimumObjectiveImprovement`、`standalone_024_scheduler_outbox_notify` + PgNotifyListener + polling fallback、Command Map 单 SSE（SchedulerRealtimeProvider；SchedulePanel 已无 `useSchedulerStream()`）。
- ⚠️ 仍为真实增量（文档 §4/§5/§6/§7 中经代码确认未覆盖的 3 项）：
  1. **P0-3 残留**：selection 单一 ownership 未完成——`useCommandMapSchedulerState` 已持有统一 `ui: CommandMapUIState`（selectedTaskId/selectedResourceId/selectedPlanId/activeLayers/panelMode/viewport），但 `CommandMap.tsx` 仍并行维护本地 `useState(selectedTaskId)`/`useState(activePlan)`（[CommandMap.tsx:197-199](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/pages/CommandMap/CommandMap.tsx#L197-L199)），`SchedulePanel` 仍维护本地 `selectedPlanId`（[SchedulePanel.tsx:195](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/pages/CommandMap/panels/SchedulePanel.tsx#L195)）并通过 `onSelectPlan` 上抛与 CommandMap 双向同步。
  2. **P1 增量**：`ReplanStabilityBudget.maxChangedAssignments` 不存在（文档 §6/§15 明确要求"如现有字段不能直接表达，再补 maxChangedAssignments"；现仅 freezeWindow/minImprovement）。`plan.service.ts:866 decideReplanApproval` 已有 HUMAN_APPROVAL_REQUIRED 机制可扩展。
  3. **P2 增量**：realtime 可观测指标缺失——`scheduler-metrics.service.ts` 仅 `sse_gap`，无文档 §11 Phase 2 要求的 notify wakeup / poll fallback / listener reconnect / resync 计数。

本 spec 只收敛上述 3 项，不重复实现已交付能力。

## What Changes（本轮范围）

1. **P0-3 补完：Command Map selection 单一 ownership**
   - `useCommandMapSchedulerState` 的 `ui` state 作为唯一 owner（含 selectedTaskId/selectedPlanId/selectedResourceId）；
   - `CommandMap.tsx` 移除本地 `useState(selectedTaskId)`/`useState(activePlan)` 双轨，统一从 hook 的 `ui` state 读写（map 层 `selectPlanForLayer`、candidates 查询、panels 传参全部改走统一 state）；
   - `SchedulePanel` 移除本地 `selectedPlanId` useState，改为受控组件（props 传入 `selectedPlanId` + `onSelectedPlanChange`），仍保留纯 UI 交互态（approve/reject/compare 弹窗等）；
   - 保持刷新/deep-link 恢复（现有 queryState 机制）与 demo 模式不回归。

2. **P1 增量：ReplanStabilityBudget.maxChangedAssignments**
   - `ReplanConfig.maxChangedAssignments?: number`（缺省 20）；
   - `plan.service.ts decideReplanApproval` 增加维度：候选方案相对基线 changed assignment 数（changed+added+removed，复用 PlanCompareService.compare）> maxChangedAssignments → `HUMAN_APPROVAL_REQUIRED`（reason `max_changed_assignments`），未超限维持原判定；
   - replan-preview 场景同步返回该 decision（若 preview 已带 approval 判定则沿用）。

3. **P2 增量：Realtime 可观测指标**
   - `scheduler-metrics.service.ts` 新增：`recordNotifyWakeup()` / `recordPollFallback()` / `recordListenerReconnect()` / `recordResync()`（counter + renderMetrics 输出）；
   - 埋点：`scheduler-stream.service.ts`（notify 触发 poll → NotifyWakeup；listener 订阅失败/未启用走轮询 → PollFallback；gap→resync → Resync）、`pg-notify.listener.ts`（重连 → ListenerReconnect）。

## Impact

- 受影响代码：
  - `ewoh-spark-app/client/src/pages/CommandMap/CommandMap.tsx`、`panels/SchedulePanel.tsx`、`hooks/useCommandMapSchedulerState.ts`、`hooks/commandMapSelector.ts`（selection 单一 owner）
  - `ewoh-spark-app/shared/scheduler.ts`（`ReplanConfig.maxChangedAssignments`）
  - `ewoh-spark-app/server/modules/scheduler/plan.service.ts`（approval 判定扩展）、`scheduler-metrics.service.ts`（新指标）、`scheduler-stream.service.ts`、`pg-notify.listener.ts`（埋点）
  - 新增测试：client（schedule-panel 受控化、selection 同步）、server（replan approval maxChanged、metrics 新计数器）
- 受影响既有 spec：`scheduler-prod-convergence`（已交付，本 spec 在其上补完）。

## ADDED Requirements

### Requirement: Command Map selection 单一 owner
系统 SHALL 使 `useCommandMapSchedulerState` 的 `ui` state 成为 selectedTaskId / selectedPlanId / selectedResourceId 的唯一 owner；CommandMap 与所有 panels 经同一 state 读写，禁止组件本地并行维护 selection。

#### Scenario: 面板与地图选中同步
- **WHEN** 用户在 SchedulePanel 选择方案
- **THEN** 统一 ui.selectedPlanId 更新，地图 plan 层与面板展示同一方案；刷新/深链后从服务端恢复同一选中
- **WHEN** 用户在 CommandMap 选择任务
- **THEN** 统一 ui.selectedTaskId 更新，candidates 查询与候选高亮基于该值，SchedulePanel 不再有独立 selectedPlanId 状态

### Requirement: Replan maxChangedAssignments 转人工审批
系统 SHALL 在 `ReplanConfig.maxChangedAssignments`（缺省 20）下，候选方案相对基线改派数（changed+added+removed）超过阈值时返回 `HUMAN_APPROVAL_REQUIRED`（reason=`max_changed_assignments`），不自动发布。

#### Scenario: 超限转人工
- **WHEN** 候选方案改派 assignment 数 > maxChangedAssignments
- **THEN** approval decision = HUMAN_APPROVAL_REQUIRED（含 reason），不自动发布；≤ 阈值时按既有规则 AUTO_REPLAN
- **WHEN** 未配置该字段
- **THEN** 行为与现状一致（缺省 20）

### Requirement: Realtime 可观测指标
系统 SHALL 记录实时链路指标：notify wakeup 次数、poll fallback 次数、listener reconnect 次数、SSE gap→resync 次数，并在 `/api/scheduler/metrics` 输出。

#### Scenario: 指标可见
- **WHEN** outbox 通知驱动一次 poll
- **THEN** `scheduler_stream_notify_wakeup_total` 递增；listener 失败走轮询时 `scheduler_stream_poll_fallback_total` 递增；重连时 `scheduler_stream_listener_reconnect_total` 递增；gap 触发 resync 时 `scheduler_sse_resync_total` 递增

## MODIFIED Requirements

### Requirement: Replan 自动重排 vs 人工审批（原 ReplanApprovalConfig）
`decideReplanApproval` 增加 `maxChangedAssignments` 维度（reason=`max_changed_assignments`）；既有 critical/lock/ratio 判定语义不变。

### Requirement: Scheduler 可观测指标（原 SchedulerMetricsService）
新增 4 个计数器（notify_wakeup / poll_fallback / listener_reconnect / sse_resync），沿用 counter + renderMetrics 输出模式；`sse_gap` 语义不变。

## REMOVED Requirements
无（本轮全部为增量/修复）。

## 明确不做（ROADMAP，仅记录）
- Phase 3 人机协同深化（candidate ranking/degraded UX/why-A-not-B 等）：经核验已在 main 交付（CandidateExplain/RejectedCandidateExplain/PlanCompare/OverridePreview 面板已存在），不重复。
- Phase 4 反馈学习（duration/travel/congestion 预测）：prediction shadow 已存在，正式预测模型迭代属后续策略，本轮不动。
- 物理目录重排（§8 模块边界）：遵循 strangler，只依赖约束不搬文件。
