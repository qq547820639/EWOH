# Checklist — Scheduler 生产级收敛（scheduler-prod-convergence）

## Task 1：生产依赖 required 化
- [ ] world-state.service.ts 的 ResourceProjectionService 为必选注入，旧直读回退分支已删除
- [ ] solver.service.ts 的 metricsService/candidateEngine 为必选（cpSatConfig 仍可选且降级显式）
- [ ] dispatch-coordinator.service.ts 的 feedbackService/policyService 为必选
- [ ] plan.service.ts 的 feedback/constraintLoader/outbox/replan 为必选
- [ ] 直接构造上述服务的既有 spec/helper 已显式注入 mock，无依赖被删除的旧回退行为
- [ ] `npx jest modules/scheduler` 全绿 + `npx tsc --noEmit` 通过

## Task 2：RouteCost STRICT/DEGRADED/ADVISORY
- [ ] `RouteCostMode` 类型与 `SchedulingPolicyConfig.routeCostMode`（缺省 DEGRADED）已定义
- [ ] STRICT 下 euclidean fallback 候选 infeasible（测试）
- [ ] DEGRADED 默认行为与现状一致（回归测试）
- [ ] ADVISORY 下 safety-critical 降级路径 dispatch 拒绝（错误码 `SAFETY_CRITICAL_DEGRADED_ROUTE`），非安全任务放行（测试）
- [ ] travel-cost / candidate / dispatch 相关 spec 通过

## Task 3：TS↔Python 契约 golden parity
- [ ] `tests/golden-fixtures/scheduler-contract.golden.json` 已创建（含 SolverRequest + SolverResponse 全字段）
- [ ] TS parity spec：字段全集一致、往返序列化一致、SolverStatus 枚举覆盖
- [ ] Python parity test：`SolverRequest.from_dict` 全字段可解析、`to_dict` 往返深等
- [ ] jest + pytest 两侧均通过

## Task 4：历史 Command Map 归档标记
- [ ] `ui/command_map/README.md` 已创建并标注 ARCHIVED / non-production、指向生产事实源

## Task 5：ReplanStabilityBudget 补全
- [ ] `ReplanConfig.freezeWindowMinutes`（缺省 15）与 `minimumObjectiveImprovement`（缺省 0.02）已定义
- [ ] freezeWindow 内 executing/dispatched/locked assignment 进入冻结集（测试）
- [ ] 非 critical 且改进不足且无冲突/硬约束待修复 → 抑制并 emit `replan.suppressed`（测试）
- [ ] safety/critical 与既有冲突修复不因阈值被抑制（测试）
- [ ] replan-storm / replan-v2-impact 等既有测试不退化

## Task 6：Outbox LISTEN/NOTIFY wake-up
- [ ] `standalone_024_scheduler_outbox_notify.{sql,rollback.sql}` + verify.sql 已新增（AFTER INSERT → pg_notify）
- [ ] SchedulerStreamService 支持可配置 LISTEN 连接，通知即 poll；LISTEN 失败回退 polling
- [ ] 通知触发 poll / 回退 polling / sequence 去重语义测试通过
- [ ] 既有 phase2-realtime / outbox 测试不退化

## Task 7：回归与提交
- [ ] 全量回归：scheduler jest + 客户端 + tsc + eslint 通过
- [ ] Python pytest（parity + 既有 edge/cpsat）通过
- [ ] OpenAPI/route-manifest 同步确认（受影响则重新生成）
- [ ] 已提交并推送 `main`（排除调试残留）
