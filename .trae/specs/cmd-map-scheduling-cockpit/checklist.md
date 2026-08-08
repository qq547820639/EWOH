# Checklist — Command Map 智能调度驾驶舱升级

## Phase A: 统一 Resource State
- [x] `ResourceStateAggregator` 收敛 person/device/station 权威状态，reservation 已水合
- [x] ResourceState 含 availability windows / currentTask / shift / version / updatedAt / freshness（有则真实，无则不伪造）
- [x] 地图/ResourcePool/Scheduler/Dispatch 消费同一资源状态来源
- [x] resource state 投影单测通过（reservation 水合、availability、freshness）

## Phase B: Dispatch 原子预占
- [x] Dispatch 事务 preflight + 原子预占 person/device/station（含 tool/vehicle when specified）
- [x] 任一资源预占失败整次回滚；保留 plan CAS / idempotency / task lifecycle / outbox
- [x] station（tool/vehicle）reservation 有 DB 唯一/排他约束
- [x] 并发双 dispatch 抢占同一 station：仅一个成功，另一个 `RESOURCE_CONFLICT`，无重叠 reservation

## Phase C: ResourcePool 收敛
- [x] 后端 `POST /plans/:planId/constraints`（或等价）提交约束并触发 replan
- [x] ResourcePoolPanel 人工操作 → SchedulingConstraint → replan，不再直接用 `allocateResources` 写 Assignment
- [x] `allocateResources` 标记 deprecated（兼容/gamification）
- [x] 拖拽锁定 Person → LOCKED_PERSON → replan → 差异展示 → approve/dispatch 集成用例

## Phase D: 前端 Scheduler SSE
- [x] `useSchedulerStream()` 连接 `/api/scheduler/v2/stream`，管理 lastEventId / reconnect / gap→resync / polling fallback / React Query cache
- [x] `SchedulePanel` 从服务端恢复 active plan（刷新/深链 planId/runId），不再仅 useState
- [x] SSE 断线重连、重复事件去重、缺口 resync 测试通过

## Phase E: Priority / Solver 可见性 / Feedback
- [x] PriorityEngine 增加 `ProductionImpact` 因子，返回结构不变，safety 不走 score 抵消
- [x] `GET /api/scheduler/tasks/:id/candidates` 返回 eligible 候选 + ETA/distance/匹配与排除理由（复用 Eligibility/route cost）
- [x] solver health / version / runtime / fallbackReason / objective breakdown 在 plan/response 可见（OPTIMAL/FEASIBLE/HEURISTIC/FALLBACK/TIMEOUT/UNAVAILABLE）
- [x] `SchedulingFeedback` 记录 planned vs actual 与 KPI；仅离线评估，不自动改生产规则

## Phase F: Command Map 驾驶舱 UI
- [x] 优先级层（未派/effective priority/deadline risk/safety/waiting + factors 弹层）
- [x] 资源可用性层（available/busy/reserved/unavailable/offline/fault/stale + current task/load/battery/location）
- [x] 候选高亮（选中任务调用 candidates，展示匹配/排除理由）
- [x] 冲突层 + plan delta + 执行偏差（planned vs actual）

## Phase G: 质量与交付
- [x] `npm test`、`npx tsc --noEmit`、lint、build 全部通过，既有 719+ 测试不退化
- [x] 排除调试残留文件，提交并推送 origin/main
- [x] 未引入平行 Scheduler；未伪造 tool/material/vehicle 数据；demo 与生产隔离