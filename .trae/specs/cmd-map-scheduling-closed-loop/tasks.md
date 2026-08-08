# Tasks — Command Map 智能调度闭环

> 目标：收敛剩余缺口，把既有 Scheduling V2 / World State / SSE / CommandMap 连成统一、实时、可解释、可回放、可人工干预的生产闭环。在 `cmd-map-scheduling-cockpit` 已交付基础上，不新建平行调度系统、不复制 backend 规则。

## 依赖与定位（先读文件确认现状）
- `server/modules/scheduler/scheduler.controller.ts`（legacy 已 @deprecated，V2 端点齐全；缺 runs 列表/snapshot/overrides/conflicts）
- `server/modules/scheduler/scheduler.service.ts`、`plan.service.ts`、`world-state.service.ts`、`impact-analyzer.ts`、`replan-coordinator.service.ts`
- `server/modules/scheduler/scheduling-policy.service.ts`、`scheduler-metrics.service.ts`、`scheduler-stream.service.ts`、`resource-projection.service.ts`
- `client/src/pages/Scheduling/Scheduling.tsx`（legacy SchedulePlan/generate/confirm）
- `client/src/api/scheduler.ts`、`client/src/hooks/useSchedulerStream.ts`、`client/src/pages/CommandMap/panels/{BrainPanel,ResourcePoolPanel,SchedulePanel}.tsx`
- `shared/api.interface.ts`、`server/database/schema.ts`

- [x] Task 1: Server authoritative run list + snapshot
  - [x] 1.1 新增 `GET /api/scheduler/runs`：分页 run/plan 历史 + 活跃方案列表（status/时间过滤），复用 SchedulingRun/SchedulingPlanV2 类型。
  - [x] 1.2 新增 `GET /api/scheduler/snapshot`：返回地图与调度器共用 authoritative operational state（freshness/dataQuality/entityVersion/reservations/availableWindows），复用 `ResourceProjectionService`/`WorldStateService`。
  - [x] 1.3 新增 shared 类型 + client `getRuns`/`getSnapshot` + React Query keys。
  - 验证：`tsc --noEmit` + 新增单测（runs-snapshot.spec.ts 6/6 通过）。

- [x] Task 2: 统一 SchedulingConflict
  - [x] 2.1 shared 新增 `SchedulingConflict` 类型（type/severity/scope/resourceId/taskIds/resolution/createdAt/snapshotVersion）。
  - [x] 2.2 后端 `GET /api/scheduler/conflicts`、`GET /api/scheduler/conflicts/:id`：从 reservation 冲突、stale plan、device offline、route blocked 等汇聚。
  - [x] 2.3 client 封装 + CommandMap 冲突层消费统一 conflict 源（不再各面板自行推断）。
  - 验证：conflicts 集成测试（9 用例通过）。

- [x] Task 3: 人工 override → constraint + replan
  - [x] 3.1 新增 `POST /api/scheduler/plans/:planId/overrides`：接收 Lock/Exclude/Boost/Preferred/Adjust → 持久化 `SchedulingConstraint`（operator/reason/validFrom/expiresAt/snapshotVersion）+ audit → 触发 replan → 返回 before/after diff。
  - [x] 3.2 复用现有 replan 约束通道；确认 `EXCLUDED_RESOURCE` / `PREFERRED_RESOURCE` 约束类型存在，缺失则补。
  - [x] 3.3 BrainPanel 的 apply 路径最终落进 V2（constraint → run → plan → approve → dispatch），不再绕过 Scheduler。
  - 验证：override 集成用例（lock→replan→diff→approve→dispatch，overrides.spec.ts 8/8 通过）。

- [x] Task 4: Scheduling 页面迁移 V2 收口
  - [x] 4.1 `Scheduling/Scheduling.tsx` 改用 `createRun` + `SchedulingPlanV2` + approve/reject/replan/dispatch；移除 legacy `generatePlans/confirmPlan`/shadow·confirmed 依赖。
  - [x] 4.2 legacy api 函数保留导出（兼容），新页面不再 import；调度事实源改为服务端 run/plan。
  - 验证：前端构建 + 组件/手测（tsc + vite build 通过）。

- [x] Task 5: 事件驱动 replan 扩充 + 冲突触发
  - [x] 5.1 扩充 trigger 集：TASK_CREATED / TASK_UPDATED / BOTTLENECK / DEADLINE_AT_RISK / ZONE_RESTRICTED / route blocked·congested / reservation conflict（现有 PERSON_UNAVAILABLE/DEVICE_OFFLINE/LOW_BATTERY/SAFETY_EVENT 保留）。
  - [x] 5.2 走 ImpactAnalyzer→局部 replan，冻结未受影响/已执行 assignment，保留 debounce/cooldown。
  - 验证：impact-analyzer / replan 集成测试（event-driven.spec.ts 9 用例，190 tests 全过）。

- [x] Task 6: 策略版本化 + 影子评估
  - [x] 6.1 核对 `SchedulingPolicyConfig` 版本化；缺失则补 `policyVersion` 列/migration。
  - [x] 6.2 新增 `GET /api/scheduler/policy`、候选版本注册与 compare/shadow（只读）接口；feedback 驱动离线评估，不自动激活生产策略。
  - [x] 6.3 激活需人工审批后才切换 active policyVersion。
  - 验证：policy 版本化单测 + shadow 只读断言（policy-version.spec.ts 7 用例，197 tests 全过）。

- [x] Task 7: 测试与回归
  - [x] 7.1 新增/扩充：runs/snapshot/conflicts/overrides/policy-version 单测与集成。
  - [x] 7.2 运行 `npm test`、`type:check`、lint、build，确保既有 739+ 测试不退化；更新 OpenAPI route-manifest 与 route audit。
  - [x] 7.3 排除调试残留文件，提交并推送 origin/main（项目约定）。

# Task Dependencies
- [Task 1] 无依赖（最先）。
- [Task 2] 依赖 [Task 1]（snapshot/权威状态）。
- [Task 3] 依赖 [Task 1]（reservation/权威状态）+ 现有 replan 约束通道。
- [Task 4] 依赖 [Task 1]（服务端 run 列表）。
- [Task 5] 依赖 [Task 2]（conflict 触发源）。
- [Task 6] 依赖 [Task 1]、[Task 5]。
- [Task 7] 依赖全部。