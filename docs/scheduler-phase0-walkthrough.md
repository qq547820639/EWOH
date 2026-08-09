# EWOH Scheduler Phase 0 — 代码走读报告

> 日期：2026-08-09 ｜ 状态：走读完成，Phase 0 实施中
> 依据：实际源码 + 本机实测（Python contract 契约失配已实测确认）

## 1. 真实调用链

```
Task/Person/Device/Station/Events
→ WorldStateService.buildSnapshot          (scheduler.service.ts:415)
→ PriorityEngine.compute                   (heuristic 内联:265；CP-SAT 复用 computeEffectivePriorityResults cp-sat:73-82)
→ EligibilityService.check                 (heuristic:402；if/else 顺序检查，无统一 IR)
→ TravelCostService.estimate               (heuristic:361；SSOT：A* route graph + Euclidean fallback 带 fallbackReason)
→ SolverService.solve                      (solver.service.ts:181)
    → CpSatSchedulingSolver.solve          (buildEligibilityMatrix→POST worker→成功 buildCpsatPlan / 失败回退 heuristic 标 FALLBACK/UNAVAILABLE)
→ Plan persistPlan                         (scheduler.service.ts:430)
→ ResourceReservationService.reserve       (dispatch-coordinator.service.ts:213 触发)
→ DispatchCoordinatorService.dispatch      (plan.service.ts:277-291)
→ Execution 记录                           (scheduler.service.ts:975，注意不在 dispatch 事务内)
→ Audit/Outbox → SSE (scheduler-stream 2s poll) → CommandMap
```

## 2. P0 问题核验结果（8/8 确认）

| # | 断言 | 结论 | 证据 |
|---|------|------|------|
| P0-1 | predecessor 仅 doneTaskIds、无时间约束 | ✅ 符合 | heuristic-scheduling-solver.ts:208-212,319-328；无显式 succ.start>=pred.end |
| P0-2 | CP-SAT 恒 all(requiredSkills) | 🔴 更严重：契约失配，CP-SAT 从未跑通过 | contract.py:12-28 无 skillMatchMode 字段；:136 SolverTask(**t) 抛 TypeError（本机实测确认）→ 400 → 恒回退 heuristic；solver.py:180 恒 all() |
| P0-3 | due 被设成 HARD，lateness 无意义 | ✅ 符合 | solver.py:319-326 end<=due OnlyEnforceIf；:388-394 lateness 恒 0；无 mustFinishBy；heuristic:313 只读 planEnd 不读 dueAtMs |
| P0-4 | CP-SAT 自行欧氏 travel | ⚠️ 部分 | Nest 侧双 solver 同源 SSOT（travel-cost.service.ts），但 worker solver.py:405-418 仍欧氏 |
| P0-5 | CP-SAT assignment 配 Heuristic metrics | ✅ 符合 | cp-sat-scheduling-solver.ts:498-510 shell 复用 |
| P0-6 | route edgeId 传入但用 task.zoneId 判断 | ✅ 符合 | replan-coordinator.service.ts:184-195 传 edgeId；impact-analyzer.ts:178-181 用 t.zoneId===entityId |
| P0-7 | station 未纳入 reservation / capacity 被忽略 | ⚠️ 部分 | station 预占已存在（dispatch-coordinator:204-211）但二值占用；EXCLUDE（standalone_009:26-33）拒绝容量>1 的第二个重叠 → 求解可行、下发失败 |
| P0-8 | CommandMap 双状态链 / plans[0] / 双 SSE | ✅ 符合 | SchedulerLayers.tsx:140 plans[0]；SSE 2 连接（useCommandMapSchedulerState.ts:60 + SchedulePanel.tsx:196） |

## 3. 与预期不符的事实

1. dispatch 已预占 station（非"只预占 person/device"）
2. RouteCost 字段名为 etaSeconds/congestionCost/riskCost（非 travelSeconds/congestionPenalty/riskPenalty）
3. trigger cooldown 仅按 (orgId, triggerType)，无 entityId；scope 不存在
4. DB 无 route_cost 表；实际为 ewoh_route_cost_matrix（矩阵缓存）
5. Execution 记录不在 dispatch 事务内（scheduler.service.ts:975，失败仅 warn）
6. PriorityEngine 无 businessPriority 输入；event_severity 分支为死路径

## 4. Phase 0 任务清单

- T1 P0-1 predecessor 显式时间约束（跨人员/设备并行）
- T2 P0-2 CP-SAT 契约修复（contract.py 加字段）+ ALL/ANY 语义 + Solver Conformance 测试
- T3 P0-3 mustFinishBy(HARD) / dueAt(SOFT) 重构
- T4 P0-4 权威 RouteCost 矩阵透传 worker（删除 worker 内欧氏）
- T5 P0-5 SchedulingObjectiveEvaluator 独立评估器（双 solver 共用，禁止 shell 复用）
- T6 P0-6 route edge→task 影响索引修复
- T7 P0-7 capacity 感知 reservation（additive migration）
- T8 P0-8 CommandMap selectedPlan/layer 状态修复
