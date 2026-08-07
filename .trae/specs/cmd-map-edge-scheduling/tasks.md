# Tasks — Command Map 智能调度闭环（Python 后端 + ui/command_map）

> 复用 `src/edge_platform/scheduler` 既有 `candidate/constraints/scoring/explanation/orchestrator/learning_loop/appeal`，在此基础上新增联合调度能力，不废弃、不平行新建另一套核心。`services.recommend/confirm_assignment` 迁移为兼容 Adapter。

## Phase 0 — 语义链路修复（最高优先级）
- [x] Task 0.1: `scheduler/models.py` 定义核心数据模型：Task / ResourceState / ScheduleRequest / CandidateAssignment / SchedulePlan / Assignment / Reservation / WorldStateSnapshot / ScheduleFeedback；Plan 状态常量与合法转换
  - [x] 0.1.1 `Task`（task_id/task_type/priority/status/station_id/zone_id/required_skills/required_device_capabilities/release_at/earliest_start/due_at/estimated_duration_sec/predecessor_task_ids/exclusive_resource_ids/load_level/safety_critical/version/created_at/updated_at）
  - [x] 0.1.2 `ResourceState`（resource_id/resource_type/status[AVAILABLE/RESERVED/BUSY/DEGRADED/OFFLINE/MAINTENANCE]/location/station_id/zone_id/skills/capabilities/current_task_id/reserved_by/reserved_until/load/battery/risk/source_ts/updated_at/version），区分主数据与实时态
  - [x] 0.1.3 `ScheduleRequest`（request_id/trigger_type/task_ids/policy_id/world_state_version/created_at/expires_at/status/created_by）
  - [x] 0.1.4 `CandidateAssignment`（task_id/person_id/device_id/station_id/route/route_distance_m/eta_sec/planned_start/planned_end/hard_constraint_results/soft_score_breakdown/score/explanation）
  - [x] 0.1.5 `SchedulePlan`（plan_id/request_id/version/assignments/objective_score/objective_breakdown/constraint_summary/world_state_version/valid_until/status/created_at/confirmed_at/confirmed_by/confirm_reason）
  - [x] 0.1.6 `Assignment`（assignment_id/task_id/plan_id/person_id/device_id/station_id/route/planned_start/planned_end/actual_start/actual_end/status/version）
  - [x] 0.1.7 `Reservation`（reservation_id/resource_id/assignment_id/plan_id/start_at/end_at/expires_at/version）
  - [x] 0.1.8 Plan 状态常量（shadow/simulating/pending_review/approved/dispatched/expired/archived）与 Task 状态常量（draft/pending_confirm/pending_approval/pending_dispatch/dispatched/received/executing/paused/exception/completed/cancelled），与 `contracts/state-machines/{plan,task}.yaml` 对齐；非法转换由后端拒绝

## Phase 1 — 统一调度核心
- [x] Task 1.1: `scheduler/world_state.py` — `WorldStateService.build_snapshot(storage, ctx)` 聚合人员/设备/任务/工位/assignment/事件/遥测，生成 `WS-YYYYMMDD-NNNN`，各数据带 timestamp；`is_stale()`/关键变化检测
- [x] Task 1.2: `scheduler/route_planner.py` — `RoutePlanner.calculate_route(from,to,constraints)->Route(distance_m/eta_sec/nodes/geometry/reachable/blocked_reason)`；`GraphRoutePlanner`（复用 `spatial/topology.shortest_path`，人员位置→最近节点→目标工位）；`EuclideanRoutePlanner` 退化 fallback
- [x] Task 1.3: `scheduler/priority.py` — `EffectivePriority`（base + deadline pressure + downstream blocking + safety urgency + aging bonus），配置化可审计
- [x] Task 1.4: `scheduler/optimizer.py` — `Optimizer.solve(world_state, tasks, candidates, policy)` 抽象 + `GreedyOptimizer`（有效优先级排序→硬约束过滤→评分→greedy 匹配→产出完整 SchedulePlan）+ `CpSatOptimizer` 接口预留/fallback
- [x] Task 1.5: `scheduler/reservation.py` — `ReservationService`（reserve/renew/release/expire/recover，乐观锁 version，冲突检测）
- [x] Task 1.6: `scheduler/planner.py` — Top-K 联合调度 Planner（复用 `CandidateGenerator`/`HardConstraints`/`Scorer`/`explanation`），一次生成 Plan A（交付优先）/B（负荷优先）/C（均衡），多 assignment，无可行解记录 violation
- [x] Task 1.7: `scheduler/scheduler_service.py` — 闭环编排：建单→快照→generate→SHADOW→PROPOSED→confirm(必填 reason，事务内重校验资源+过期)→Reservation→Assignment→execute（仅 CONFIRMED/approved）→feedback；reject/replan；全量审计
- [x] Task 1.8: `scheduler/replanner.py` — 局部重调度（device offline/person unavailable/插单/安全事件/工位不可用/assignment timeout/ETA 超阈值/plan 过期），冻结 executing+locked，计划稳定性成本，输出 Plan vN vs vN+1 差异（unchanged/added/removed/reassigned/delayed）
- [x] Task 1.9: `scheduler/__init__.py` 导出新增模块；`orchestrator.py` 保留为兼容层，与 SchedulerService 做状态映射

## Phase 2 — 持久化
- [x] Task 2.1: `stubs.py` SCHEMA 新增表（幂等 CREATE TABLE IF NOT EXISTS）：task / scheduling_request / scheduling_plan / scheduling_plan_assignment / assignment / resource_reservation / schedule_decision / schedule_feedback / world_state_snapshot；核心字段结构化，score/explanation 用 JSON
- [x] Task 2.2: `scheduler/repository.py` — `SchedulingRepository` load/save 上述表，含乐观锁 version 冲突
- [x] Task 2.3: 服务重启后数据不丢失；`ctx.assignments`（内存）迁移到 repository

## Phase 3 — World State + 实时资源状态
- [x] Task 3.1: 统一的实时资源状态聚合（人员/设备/工位/任务/Assignment/遥测），version/snapshot
- [x] Task 3.2: `GET /api/resources/state` 输出统一资源状态

## Phase 4 — 真实空间匹配
- [ ] Task 4.1: 接入 `spatial.topology.shortest_path` 计算真实 route/distance/ETA；travel_distance 优先拓扑路径距离，无拓扑退化到空间距离
- [ ] Task 4.2: 地图展示 Plan 真实路径（非 yaw 虚线冒充）

## Phase 5 — 实时同步
- [x] Task 5.1: `GET /api/command-map/stream`（SSE）推送 resource.updated/telemetry.updated/task.created/task.updated/assignment.updated/schedule.proposed/schedule.confirmed/schedule.expired/schedule.conflict/event.opened/event.closed；事件带 event_id/event_type/entity_id/version/source_ts/server_ts
- [x] Task 5.2: polling fallback；前端只接受比当前 version 新的数据

## Phase 6 — API
- [x] Task 6.1: `server.py` 新增：GET/POST /api/tasks、GET/PATCH /api/tasks/{id}、GET /api/resources/state、POST /api/scheduling/requests、GET /api/scheduling/requests/{id}、GET /api/scheduling/plans、GET /api/scheduling/plans/{id}、POST /api/scheduling/plans/{id}/confirm、/reject、/replan、GET /api/assignments、POST /api/assignments/{id}/start、/pause、/complete、/cancel、/override
- [x] Task 6.2: confirm 请求带 plan_id/plan_version/world_state_version/actor_id/reason；确认前最终约束检查 + Reservation；冲突返回机读错误（PLAN_STALE/WORLD_STATE_CHANGED/RESOURCE_CONFLICT/CONSTRAINT_CHANGED/PLAN_EXPIRED，HTTP 409）
- [x] Task 6.3: `services.recommend/confirm_assignment` 改为兼容 Adapter（内部走 Scheduler，标记 deprecated），旧接口行为不破坏

## Phase 7 — 前端改造
- [ ] Task 7.1: `assets/app.js` — 新增 fetchTasks/fetchScheduleRequests/fetchPlans/fetchAssignments/confirmPlan/rejectPlan/replan/stream events；backend 可用时调度数据全部来自 backend；SAMPLE_DATA 仅 offline/demo
- [ ] Task 7.2: `scenario-panel/` — 真实 SchedulePlan 审批（状态/版本/world_state_version/有效期/完整 assignments：task/person/device/station/start/end/route/distance/ETA/score/explanation；方案比较 on-time/late/travel/high-load/changeover/utilization/unassigned/conflicts/stability；操作 Confirm/Reject/Replan/Pin/Override/Freeze）
- [ ] Task 7.3: `map/map.js` — scheduling 模式展示人员当前位置/目标工位/真实调度路线/移动方向/ETA/任务ID/优先级/person/device/assignment status；切换 Current Assignments/Proposed Plan/Confirmed Plan；yaw 短虚线仅作短时趋势
- [ ] Task 7.4: `workbench/` — 高优先级未派任务/待确认 Plan/冲突 Plan/过期 Plan/异常 Assignment/需人工 replan
- [ ] Task 7.5: `entity-panel/` — 点击 Task/Person/Device/Station/Assignment 展示相关调度关系

## Phase 8 — 测试 + 质量
- [ ] Task 8.1: 新增 `src/edge_platform/tests/test_scheduling.py`（unittest）覆盖：Domain（Task/Plan 状态机、ResourceState、Reservation、version conflict）、Constraint（技能/工位授权/设备兼容/离线/禁区/班次/休息/时间冲突/重复占用/station capacity）、Routing（shortest path/distance/unreachable/fallback）、Scheduling（单任务单资源/多任务多资源/高优先级优先/deadline/资源不足/依赖/aging/时间重叠）、HITL（SHADOW 不可执行/确认带 actor+reason/旧版本不可确认/资源变化不可确认/Reject 不可执行）、Replan（device offline/person unavailable/插单/冲突/冻结）、API（create task/create request/get plan/confirm/reject/replan/assignment lifecycle/409 stale）
- [ ] Task 8.2: 运行 `make test`、`make test-contract`、`make lint`，修复本次改动引入的失败；原有 scheduler 测试不退化
- [ ] Task 8.3: 端到端手测：建单→generate→Top-3→confirm→Reservation→Assignment→feedback 闭环可用（`python tools/run_demo.py --no-browser` + curl）

# Task Dependencies
- Task 1.x 依赖 Task 0.1（模型）
- Task 2.x 依赖 Task 0.1、1.7（表结构 + 服务）
- Task 3.x 依赖 Task 1.1、2.x
- Task 4.x 依赖 Task 1.2
- Task 5.x 依赖 Task 3.x、6.3
- Task 6.x 依赖 Task 1.7、2.x
- Task 7.x 依赖 Task 6.x
- Task 8.x 依赖全部