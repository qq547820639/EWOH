# Checklist — Scheduler 生产级收敛（scheduler-prod-convergence）

## Task 1：生产依赖 required 化
- [x] world-state.service.ts 的 ResourceProjectionService 为必选注入，旧直读回退分支已删除
- [x] solver.service.ts 的 metricsService/candidateEngine 为必选（cpSatConfig 仍可选且降级显式）
- [x] dispatch-coordinator.service.ts 的 feedbackService/policyService 为必选
- [x] plan.service.ts 的 feedback/constraintLoader/outbox/replan 为必选
- [x] 直接构造上述服务的既有 spec/helper 已显式注入 mock，无依赖被删除的旧回退行为
- [x] `npx jest modules/scheduler` 全绿（68 suites/495 tests）+ `npx tsc --noEmit` 通过（server/spec 零错误）

## Task 2：RouteCost STRICT/DEGRADED/ADVISORY
- [x] `RouteCostMode` 类型与 `SchedulingPolicyConfig.routeCostMode`（缺省 DEGRADED）已定义
- [x] STRICT 下 euclidean fallback 候选 infeasible（测试：travel-cost.spec.ts + route-cost-mode.spec.ts）
- [x] DEGRADED 默认行为与现状一致（回归测试）
- [x] ADVISORY 下 safety-critical 降级路径 dispatch 拒绝（错误码 `SAFETY_CRITICAL_DEGRADED_ROUTE`），非安全任务放行（测试）
- [x] travel-cost / candidate / dispatch 相关 spec 通过

## Task 3：TS↔Python 契约 golden parity
- [x] `tests/golden-fixtures/scheduler-contract.golden.json` 已创建（含 SolverRequest + SolverResponse 全字段）
- [x] TS parity spec：字段全集一致、往返序列化一致、SolverStatus 枚举覆盖（5 passed）
- [x] Python parity test：`SolverRequest.from_dict` 全字段可解析、`to_dict` 往返深等（5 passed）
- [x] jest + pytest 两侧均通过

## Task 4：历史 Command Map 归档标记
- [x] `ui/command_map/README.md` 已创建并标注 ARCHIVED / non-production、指向生产事实源

## Task 5：ReplanStabilityBudget 补全
- [x] `ReplanConfig.freezeWindowMinutes`（缺省 15）与 `minimumObjectiveImprovement`（缺省 0.02）已定义
- [x] freezeWindow 内近期 assignment 进入冻结集（LOCKED_ASSIGNMENT 语义，测试）
- [x] 非 critical 且改进不足且无冲突/硬约束待修复 → 抑制并 emit `replan.suppressed`（reason=minimum_objective_improvement，测试）
- [x] safety/critical 与既有冲突修复不因阈值被抑制（测试）
- [x] replan-storm / replan-v2-impact 等既有测试不退化

## Task 6：Outbox LISTEN/NOTIFY wake-up
- [x] `standalone_024_scheduler_outbox_notify.{sql,rollback.sql}` + verify.sql 已新增（AFTER INSERT → pg_notify），runner 已注册
- [x] SchedulerStreamService 支持可配置 LISTEN 连接（SCHEDULER_STREAM_NOTIFY=1），通知即 poll；LISTEN 失败回退 polling
- [x] 通知触发 poll / 回退 polling / sequence 去重语义测试通过（scheduler-stream-wakeup.spec.ts 5 passed）
- [x] 既有 phase2-realtime / outbox 测试不退化

## Task 7：回归与提交
- [x] 全量回归：scheduler jest（495）+ 客户端 jest（726）+ tsc + eslint 通过
- [x] Python pytest（parity + 既有 edge/cpsat）21 passed / 10 skipped（ortools 依赖）
- [x] OpenAPI/route-manifest 同步确认：`openapi:no-drift` 通过，无需重新生成
- [x] 已提交并推送 `main`（commit 60c7808，35 files；排除调试残留与用户未提交改动）
