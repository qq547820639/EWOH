# Tasks

> 遵循「保持现有系统可运行 + 渐进式升级」。核心调度域落在主应用 `ewoh-spark-app`；`ui/command_map` 与 `src/edge_platform/scheduler` 保留为参考，不承载核心调度域。

- [x] Task 1: 数据库模型与 migration
  - [x] 1.1 在 `server/database/schema.ts` 新增表：`ewohSchedulingRun`、`ewohSchedulingPlan`(重构/扩展原 `ewoh_schedule_plan`)、`ewohSchedulingPlanAssignment`、`ewohSchedulingConstraint`、`ewohWorldStateSnapshot`、`ewohRouteNode`、`ewohRouteEdge`、`ewohAssignmentEvent`
  - [x] 1.2 新增 `db/migrations/standalone_006_scheduling.sql`（含 rollback 与 verify）
  - [x] 1.3 在 `db/runner/run_migrations.js` 注册 standalone_006 相关命令
  - [x] 1.4 扩展 `ewoh_personnel`/`ewoh_device`/`ewoh_production_task` 需要的调度字段（skills/certifications/availability/currentPosition/zone/workload/battery/capabilities/earliestStart/deadline/predecessor 等，尽量复用已有列，缺失才加）

- [x] Task 2: 共享领域类型（API contract）
  - [x] 2.1 在 `shared/api.interface.ts`（或对应共享类型文件）新增 WorldStateSnapshot / SchedulingRun / SchedulingPlan / Assignment / Route / EligibilityResult / SchedulingPolicy / LockedConstraint / Trigger 类型
  - [x] 2.2 定义 Assignment 状态机常量与 Plan 状态常量（draft/shadow/approved/dispatched/executing/completed/rejected/superseded）

- [x] Task 3: WorldStateSnapshot + TriggerService
  - [x] 3.1 实现快照生成（聚合人员/任务/设备/工位/backlog/路线/禁行/锁定 assignment，生成 `WS-YYYYMMDD-NNNN`）
  - [x] 3.2 实现快照过期校验（Approve 前判定 major change → 409 PLAN_STALE）
  - [x] 3.3 实现 TriggerService：识别 STATION_BACKLOG 等 10 类触发源，发起 SchedulingRun，带 debounce/cooldown

- [x] Task 4: EligibilityService + RoutingService
  - [x] 4.1 实现硬约束校验（技能/认证/在岗/时间冲突/风险/设备可用/能力/离线/电量/区域权限/前置任务/连续作业/安全），输出 eligible + reasons
  - [x] 4.2 复用并收敛现有 `candidate`/`constraints` 逻辑
  - [x] 4.3 实现 RouteNode/RouteEdge 数据与 A*/最短路径、ETA 计算（distance/congestion/risk/blocked）

- [x] Task 5: Scheduling Solver + PlanService
  - [x] 5.1 实现确定性启发式 Solver：硬约束 + 加权软目标（权重来自可配置 SchedulingPolicy）
  - [x] 5.2 一次生成 Plan A（交付优先）/Plan B（负荷优先）/Plan C（均衡）
  - [x] 5.3 实现 Explainability（每 assignment 的 reasons + alternatives）
  - [x] 5.4 实现 Replan：冻结 executing/locked，重排未来 30–60 分钟，引入 changeCost
  - [x] 5.5 实现无可行解处理（不生成虚假 assignment，记 violation）

- [x] Task 6: Scheduling API + 审计
  - [x] 6.1 在 scheduler.controller.ts 新增：POST /runs、GET /runs/:runId、GET /plans/:planId、POST /plans/:planId/approve、/reject、/dispatch、/replan、GET /plans/:planId/compare/:otherPlanId
  - [x] 6.2 新增 GET /routes、POST /routes/calculate
  - [x] 6.3 所有关键动作写审计（actor/action/timestamp/planId/version/before/after/reason）

- [x] Task 7: 前端接入真实 SchedulingPlan
  - [x] 7.1 更新 `client/src/api/scheduler.ts` 封装新 API
  - [x] 7.2 重构 `panels/SchedulePanel.tsx` 为 Plan 审批（Header/KPI/Assignment Changes + Approve/Reject/Compare/Adjust/Replan）
  - [x] 7.3 `CommandMap.tsx` 接入真实 Plan：Shadow Plan 虚线路线、半透明预测人员、目标工位标记、拥堵/封闭标记
  - [x] 7.4 人员/任务交互详情展示调度解释（为何选中、备选人）+ Compare Mode
  - [x] 7.5 保留 SAMPLE_DATA 为 Demo fallback，真实后端返回时使用真实 Plan

- [x] Task 8: Demo 数据与种子
  - [x] 8.1 构建 8–12 人员、15–20 任务、≥5 设备、5 区域（LINE-A/LINE-B/WAREHOUSE/CHARGE/PACKING）Demo 场景
  - [x] 8.2 设置 LINE-B backlog 升高场景，验证 Plan A/B/C 与地图路线差异
  - [x] 8.3 种子 route_nodes/route_edges 与调度相关数据

- [x] Task 9: 测试
  - [x] 9.1 12 项核心测试（技能不匹配不可调度/单人单时段/单设备单任务/blocked 边不可选/deadline 优先/locked 不被 Replan 改/executing 不被移走/旧快照不可 Approve/Plan A/B/C 权重不同/设备离线后 Replan/无可行解不造假/结果可解释）

- [x] Task 10: 质量门禁
  - [x] 10.1 运行 lint、typecheck、tests、build，修复本次改动引入的问题

# Task Dependencies
- Task 2 依赖 Task 1（类型对齐 schema）
- Task 3 依赖 Task 2（快照/触发类型）
- Task 4 依赖 Task 1、2（人员/设备/任务字段 + 类型）
- Task 5 依赖 Task 3、4（快照 + eligibility + route）
- Task 6 依赖 Task 5（Solver 产出）+ Task 1（表）
- Task 7 依赖 Task 6（API）+ Task 5（真实 Plan）
- Task 8 依赖 Task 1（表与字段）
- Task 9 依赖 Task 5、6
- Task 10 依赖全部