# Checklist — Command Map 智能调度闭环（Python 后端 + ui/command_map）

## Phase 0 — 语义链路
- [ ] 前端 `app.js` 不再以 `CM.SAMPLE_DATA.plans` 作为 backend 模式的真实调度方案；SAMPLE_DATA 仅用于明确 offline/demo
- [ ] scenario-panel 确认时提交真实 plan_id/plan_version/world_state_version/actor_id/reason，不再把本地 planId 冒充 taskId
- [ ] 后端 Assignment 来源可追溯到真实 plan_id；前端确认的 plan_id 与数据库 Plan 完全一致
- [ ] Plan 状态常量（shadow/simulating/pending_review/approved/dispatched/expired/archived）与 Task 状态常量（draft/…/executing/completed/cancelled）与 `contracts/state-machines/{plan,task}.yaml` 对齐；非法状态转换由后端拒绝

## Phase 1 — 统一调度核心
- [ ] WorldStateSnapshot 生成 `WS-YYYYMMDD-NNNN`，Plan 绑定 world_state_version；过期/关键变化确认返回 409（PLAN_STALE/WORLD_STATE_CHANGED）
- [ ] RoutePlanner 复用 `spatial/topology.shortest_path` 计算真实 route/distance/ETA；无拓扑退化到空间距离；unreachable 返回 blocked_reason
- [ ] EffectivePriority 综合 base/deadline/blocking/safety/aging，配置化可审计，防饥饿
- [ ] Optimizer 抽象 `solve(world_state, tasks, candidates, policy)`，GreedyOptimizer 实现，CpSatOptimizer 接口预留/fallback
- [ ] ReservationService 支持 reserve/renew/release/expire/recover，乐观锁 version 防并发冲突
- [ ] Planner 一次生成 Top-K（默认 Plan A/B/C），多 assignment，无可行解记录 violation 不造假
- [ ] SchedulerService 闭环：建单→快照→generate→SHADOW→PROPOSED→confirm→Reservation→Assignment→execute（仅 approved 可执行）→feedback；reject/replan；全量审计（actor/action/ts/原状态/新状态/planId/version/理由）
- [ ] Replanner 局部重调度，冻结 executing/locked，计划稳定性成本，输出 Plan vN vs vN+1 差异（unchanged/added/removed/reassigned/delayed）
- [ ] `services.recommend/confirm_assignment` 迁移为兼容 Adapter（内部走 Scheduler，标记 deprecated），旧接口行为不破坏

## Phase 2 — 持久化
- [ ] stubs.py SCHEMA 新增表：task / scheduling_request / scheduling_plan / scheduling_plan_assignment / assignment / resource_reservation / schedule_decision / schedule_feedback / world_state_snapshot（幂等建表）
- [ ] 核心字段结构化，score/explanation 用 JSON；服务重启后数据不丢失；乐观锁 version 冲突

## Phase 3 — World State + 实时资源
- [x] 统一实时资源状态聚合；`GET /api/resources/state` 输出 ResourceState（AVAILABLE/RESERVED/BUSY/DEGRADED/OFFLINE/MAINTENANCE）

## Phase 4 — 真实空间匹配
- [ ] 地图展示 Plan 真实路径（非 yaw 短虚线冒充）；候选 travel_distance 优先拓扑路径距离

## Phase 5 — 实时同步
- [x] `GET /api/command-map/stream`（SSE）推送 resource/telemetry/task/assignment/schedule/event 事件，均带 event_id/event_type/entity_id/version/source_ts/server_ts
- [x] polling fallback 保留，SSE 断开时页面可用；前端只接受比当前 version 新的数据

## Phase 6 — API
- [x] API 齐全：tasks CRUD、resources/state、scheduling/requests、scheduling/plans(+confirm/reject/replan)、assignments(+start/pause/complete/cancel/override)
- [x] confirm 前最终约束检查 + Reservation；冲突返回机读 error（PLAN_STALE/WORLD_STATE_CHANGED/RESOURCE_CONFLICT/CONSTRAINT_CHANGED/PLAN_EXPIRED，HTTP 409）

## Phase 7 — 前端
- [ ] scenario-panel 展示真实 Plan 审批（状态/版本/world_state_version/有效期/完整 assignments/方案比较/Confirm/Reject/Replan/Pin/Override/Freeze）
- [ ] map.js scheduling 模式展示真实调度路线/ETA/任务/优先级/person/device/assignment status；可切换 Current/Proposed/Confirmed
- [ ] workbench 展示高优先级未派任务/待确认/冲突/过期 Plan/异常 Assignment/需 replan
- [ ] entity-panel 点击 Task/Person/Device/Station/Assignment 展示调度关系

## Phase 8 — 测试
- [ ] 新增 test_scheduling.py 覆盖 Domain/Constraint/Routing/Scheduling/HITL/Replan/API 全部类目
- [ ] `make test`、`make test-contract`、`make lint` 通过；原有 scheduler 测试不退化
- [ ] 端到端手测闭环可用（建单→generate→Top-3→confirm→Reservation→Assignment→feedback）