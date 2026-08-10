# Tasks — Scheduler 生产级收敛（scheduler-prod-convergence）

> 原则：先补测试暴露问题 → 改代码 → 回归。后端改动聚焦 `ewoh-spark-app/server/modules/scheduler/`，DB 增量走 `db/migrations/`。每个 Task 独立可运行、可验证，完成后立即跑相关测试。最后统一提交并推送 `main`。

## Phase P0 — 一致性基线

- [x] Task 1: 生产关键依赖 required 化（消除 optional 静默回退）
  - [x] 1.1 `world-state.service.ts`：`resourceProjectionService` 改为必选构造参数，删除 `else` 旧直读回退分支（personnel.map 等），生产路径唯一。
  - [x] 1.2 `solver.service.ts`：`metricsService` 与 `candidateEngine` 改为必选；`cpSatConfig` 保持可选（显式 UNAVAILABLE/FALLBACK 降级属合规行为）。
  - [x] 1.3 `dispatch-coordinator.service.ts`：`feedbackService` 与 `policyService` 改为必选；`resolveDefaultDurationMs` 不再走 undefined 分支。
  - [x] 1.4 `plan.service.ts`：`feedbackService`/`constraintLoaderService`/`outboxService`/`replanCoordinator` 改为必选；删除缺失时回退分支。
  - [x] 1.5 更新直接构造这些服务的既有 spec/helper（`scheduler-test-helpers.ts`、`dispatch-test-harness.ts`、`scheduler-domain.spec.ts`、`world-state-derive.spec.ts`、`replan-preview.service.spec.ts`、`plan-persistence.spec.ts`、`overrides.spec.ts`、`constraint-lifecycle.spec.ts`、`dispatch-integration.spec.ts`、`shadow-plan-guard.spec.ts` 等）显式注入 mock。
  - [x] 1.6 验证：`npx jest modules/scheduler` 全绿（64 suites/468 tests）+ `npx tsc --noEmit`（server 零错误）；无 spec 依赖被删除的旧回退行为。

- [x] Task 2: RouteCost STRICT / DEGRADED / ADVISORY 策略
  - [x] 2.1 `shared/scheduler.ts`：新增 `RouteCostMode = 'STRICT'|'DEGRADED'|'ADVISORY'`；`SchedulingPolicyConfig.routeCostMode?: RouteCostMode`（缺省 DEGRADED）。
  - [x] 2.2 `travel-cost.service.ts`：mode 感知——STRICT 下 euclidean fallback 候选 `feasible=false`（route_infeasible）；DEGRADED/ADVISORY 维持现状成本+标记+惩罚。
  - [x] 2.3 `dispatch-coordinator.service.ts`：ADVISORY 模式下 safety-critical assignment 若 routeCostMode=euclidean_fallback → 拒绝派工，错误 `SAFETY_CRITICAL_DEGRADED_ROUTE`；非安全任务正常派工。
  - [x] 2.4 新增测试：STRICT 拒绝降级候选（candidate 不可行）；DEGRADED 默认行为不变；ADVISORY 阻断 safety dispatch、放行非安全；缺省模式 = DEGRADED。
  - [x] 验证：`travel-cost.spec.ts`、`route-cost-mode.spec.ts`、`dispatch-integration.spec.ts` 全绿（66 suites/484 tests）；`tsc` server 零错误。

- [x] Task 3: TS↔Python 契约 golden fixture parity test
  - [x] 3.1 新增 `tests/golden-fixtures/scheduler-contract.golden.json`：包含代表性 `SolverRequest`（tasks/persons/devices/stations/reservations/candidateCosts/frozenAssignments/constraints/weights）与 `SolverResponse`（solverStatus/objectiveBreakdown/assignments/rejectedAlternatives）。
  - [x] 3.2 新增 TS parity spec `ewoh-spark-app/server/modules/scheduler/__tests__/solver-contract-parity.spec.ts`：从 `tests/golden-fixtures/` 加载 golden，断言字段全集一致（无缺/无多）、可序列化往返、`SolverStatus` 枚举值 ⊇ {OPTIMAL,FEASIBLE,FALLBACK,INFEASIBLE,TIMEOUT,UNAVAILABLE}。
  - [x] 3.3 新增 `tests/test_ts_python_contract_parity.py`：加载同一 golden，`SolverRequest.from_dict` 全字段可解析、`SolverResponse.to_dict` 往返深等、枚举值集合与 TS 一致。
  - [x] 验证：`npx jest modules/scheduler/__tests__/solver-contract-parity.spec.ts`（5 passed）+ `pytest tests/test_ts_python_contract_parity.py`（5 passed）全绿。

- [x] Task 4: 历史 `ui/command_map/` archived 标记
  - [x] 4.1 新增 `ui/command_map/README.md`：明确标注 ARCHIVED / non-production 参考原型；生产 Command Map 事实源 = `ewoh-spark-app/client/src/pages/CommandMap/`；禁止在此实现生产功能。
  - [x] 验证：README 存在且内容准确。

## Phase P1 — 求解与重排稳定性

- [x] Task 5: ReplanStabilityBudget 补全（freezeWindow + minimumObjectiveImprovement）
  - [x] 5.1 `shared/scheduler.ts`：`ReplanConfig` 新增 `freezeWindowMinutes?: number`（缺省 15）与 `minimumObjectiveImprovement?: number`（缺省 0.02）。
  - [x] 5.2 `replan-coordinator.service.ts`：影响分析后，将 freezeWindow 内 executing/dispatched/locked 的 assignment 并入冻结集（不改 FROZEN 状态语义）。
  - [x] 5.3 `replan-coordinator.service.ts`：求解后若非 critical/safety 触发、无待修复冲突/硬约束、且候选 objective 改进 < threshold → 抑制重排并 emit `replan.suppressed`（含 reason=minimum_objective_improvement）。
  - [x] 5.4 新增/扩充测试：freeze 窗口冻结近期 assignment；改进不足抑制；critical/safety/冲突修复绕过阈值；既有 replan-storm/replan-v2-impact 不退化。
  - [x] 验证：`replan-stability-budget.spec.ts`（6 新增）+ `replan-storm.spec.ts`、`replan-v2-impact.spec.ts` 全绿（68 suites/495 tests）；`tsc` server 零错误。

## Phase P2 — 实时低延迟

- [x] Task 6: Outbox → Postgres LISTEN/NOTIFY 低延迟 wake-up
  - [x] 6.1 新增 `db/migrations/standalone_024_scheduler_outbox_notify.sql` + `.rollback.sql`：`ewoh_outbox` AFTER INSERT trigger → `pg_notify('scheduler_outbox', '')`（同一事务提交后才送达）。
  - [x] 6.2 新增 `db/verify/standalone_024_scheduler_outbox_notify.verify.sql`。
  - [x] 6.3 `scheduler-stream.service.ts`：新增可选 LISTEN 连接（配置 `SCHEDULER_STREAM_NOTIFY=1` 时启用；注入 listener 工厂便于单测）；收到通知即触发一次 `poll()`；LISTEN 失败仅记日志，2s polling 兜底不变。
  - [x] 6.4 新增测试：通知触发 poll（mock listener）；LISTEN 不可用时回退 polling；sequence 去重/推进语义不变。
  - [x] 验证：`scheduler-stream-wakeup.spec.ts`（5 新增）+ `phase2-realtime.spec.ts`、`scheduler-stream-last-event-id.spec.ts`、`scheduler-sse-events.spec.ts` 全绿（68 suites/495 tests）；runner 已注册 024 分支。

## 回归与交付

- [ ] Task 7: 回归 + 契约 + 提交
  - [ ] 7.1 全量回归：`npx jest modules/scheduler`（含新增 spec）+ 客户端 scheduler 相关 + `npx tsc --noEmit` + 改动文件 eslint。
  - [ ] 7.2 Python 侧：`pytest tests/test_ts_python_contract_parity.py` + 既有 edge/cpsat 测试不退化。
  - [ ] 7.3 契约/OpenAPI：本次 `shared/scheduler.ts` 新增纯 TS 类型与可选配置字段，确认是否需同步 `openapi/route-manifest.json`（如 route-manifest 含 SchedulingPolicyConfig 则重新生成）。
  - [ ] 7.4 排除调试残留，提交并推送 `main`（项目约定）。

# Task Dependencies
- [Task 1] 无依赖（先行，消除回退分支降低后续改造成本）。
- [Task 2] 无依赖；并行于 [Task 1/3/4]。
- [Task 3] 无依赖；并行。
- [Task 4] 无依赖；并行。
- [Task 5] 依赖 [Task 1] 落地的 required 注入形态（replan 相关服务构造点）后并行开展。
- [Task 6] 无依赖；并行于 [Task 1-5]（独立模块与 migration）。
- [Task 7] 依赖全部。
