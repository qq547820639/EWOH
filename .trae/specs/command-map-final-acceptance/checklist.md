# Checklist — Command Map 最终验收收敛（command-map-final-acceptance）

## Task 1：Command Map selection 单一 owner
- [ ] useCommandMapSchedulerState 的 `ui` state 为 selectedTaskId/selectedPlanId/selectedResourceId 唯一 owner
- [ ] CommandMap.tsx 已移除本地 selectedTaskId/activePlan 双轨 useState
- [ ] SchedulePanel 为受控组件（无本地 selectedPlanId），approve/reject/compare 纯 UI 交互态保留
- [ ] 面板选方案 → 地图层同步同一方案；地图选任务 → candidates/高亮基于统一 state（测试）
- [ ] 刷新/深链恢复与 demo 模式不回归
- [ ] client tsc + schedule-panel / use-command-map-scheduler-state / scheduler-layers-select 测试全绿

## Task 2：Replan maxChangedAssignments 转人工审批
- [ ] `ReplanConfig.maxChangedAssignments?: number`（缺省 20）已定义
- [ ] decideReplanApproval 新增 maxChangedAssignments 维度（reason=max_changed_assignments）
- [ ] 超限 → HUMAN_APPROVAL_REQUIRED 且不自动发布；未超限维持原判定（测试）
- [ ] 未配置字段 → 缺省 20 生效（测试）；既有 replan-preview/replan-stability 不退化
- [ ] scheduler jest（plan/replan 相关）+ server tsc 通过

## Task 3：Realtime 可观测指标
- [ ] recordNotifyWakeup / recordPollFallback / recordListenerReconnect / recordResync 已实现并输出 renderMetrics
- [ ] scheduler-stream（notify→wakeup、listener 失败→poll fallback、gap→resync）与 pg-notify.listener（reconnect）已埋点
- [ ] metrics 计数器断言测试 + wakeup 埋点测试通过
- [ ] scheduler-metrics.spec.ts / scheduler-stream-wakeup.spec.ts 全绿

## Task 4：回归与提交
- [ ] 全量回归：scheduler jest + 客户端 jest + tsc（server/client）+ eslint 通过
- [ ] openapi:no-drift 确认（纯 TS 可选字段，无需重新生成）
- [ ] 已提交并推送 `main`（排除调试残留与用户未提交改动）
