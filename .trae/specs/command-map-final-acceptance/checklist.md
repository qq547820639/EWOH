# Checklist — Command Map 最终验收收敛（command-map-final-acceptance）

## Task 1：Command Map selection 单一 owner
- [x] useCommandMapSchedulerState 的 `ui` state 为 selectedTaskId/selectedPlanId/selectedResourceId 唯一 owner（applyUiPatch + updateUi）
- [x] CommandMap.tsx 已移除本地 selectedTaskId/activePlan 双轨 useState（activePlan 由 ui.selectedPlanId 解析，禁止 plans[0] 回退）
- [x] SchedulePanel 为受控组件（无本地 selectedPlanId，props 受控 + onSelectPlan），approve/reject/compare 纯 UI 交互态保留
- [x] 面板选方案 → 统一 state 更新且地图层同步；地图选任务 → candidates/高亮基于统一 state（applyUiPatch 测试）
- [x] 刷新/深链恢复与 demo 模式不回归（深链 effect 移除 plans[0] 回退，终态等价）
- [x] client tsc 零新增（基线 18 条既有错误一致）+ schedule-panel / use-command-map-scheduler-state / scheduler-layers-select 测试全绿（14 tests；全量 client 730 tests）

## Task 2：Replan maxChangedAssignments 转人工审批
- [x] `ReplanApprovalConfig.maxChangedAssignments?: number`（缺省 20）已定义（DEFAULT_CONFIG 同步缺省 20）
- [x] consultReplanApproval 新增 maxChangedAssignments 维度（reason=max_changed_assignments）
- [x] 超限 → HUMAN_APPROVAL_REQUIRED 且不自动发布；未超限维持原判定（测试：6 超限命中 / 5 等值不命中）
- [x] 未配置字段 → 缺省 20 生效（21 命中 / 20 不命中测试）；既有 replan-preview/replan-stability 不退化
- [x] scheduler jest（plan/replan 相关 503 tests）+ server tsc（spec 零错误）通过

## Task 3：Realtime 可观测指标
- [x] recordNotifyWakeup / recordPollFallback / recordListenerReconnect / recordResync 已实现并输出 renderMetrics
- [x] scheduler-stream（notify→wakeup、listener 失败→poll fallback、gap→resync）与 pg-notify.listener（onReconnect）已埋点，module useFactory 注入 metricsService
- [x] metrics 计数器断言测试 + wakeup 埋点测试通过（净增 8 用例）
- [x] scheduler-metrics.spec.ts / scheduler-stream-wakeup.spec.ts / phase2-realtime.spec.ts 全绿（68 suites/503 tests）

## Task 4：回归与提交
- [x] 全量回归：scheduler jest 503 + 客户端 jest 730 + tsc（spec 零错误）+ eslint 全绿
- [x] openapi:no-drift 通过（纯 TS 可选字段，无需重新生成）
- [x] 已提交并推送 `main`（commit 87988a1，19 files，排除调试残留与用户未提交改动）
