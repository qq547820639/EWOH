# EWOH 指挥地图智能调度 — Incremental Replan V2 迭代交付报告

> 日期：2026-08-10 ｜ 团队：software-ewoh-scheduler（交付总监齐活林 / 架构师高见远 / 工程师寇豆码 / QA 严过关）
> 基线：d48d6cc → 8a1cb55（9 commits，已 push origin/main）
> 状态：✅ COMPLETE（QA 独立验证全过，唯一缺陷已修复闭环）

---

## 1. 最终状态

**COMPLETE**

- 本轮全部实现里程碑（M01-M05）完成并提交，QA 独立验证 23 项验收全过。
- QA 判定的 1 项 P2 缺陷（replan.suppressed SSE 未发射）已由工程师修复并回归通过。
- 9 个 commit 已全部推送 origin/main。

## 2. Git

| 项 | 值 |
|---|---|
| branch | main |
| starting HEAD | d48d6cc（= origin/main） |
| ending HEAD | 8a1cb55（= origin/main） |
| commits | 9（见下表） |
| push result | ✅ `d48d6cc..8a1cb55 main -> main` |

| commit | 内容 |
|---|---|
| c162a48 | chore(scheduler): restore clean regression baseline |
| 1c9d2bb | feat(scheduler): add deterministic replan impact model（M01） |
| 1c5b390 | feat(scheduler): replan v2 core with storm guard and candidate engine wiring（M02） |
| 8aeee26 | feat(scheduler): expose replan preview diff and approval policy（M03） |
| 8f31335 | feat(scheduler): minimize incremental replan churn with v2 objective and kpi（M04） |
| 3d796c6 | feat(scheduler): record shadow predictions with canary guard（M05 服务端） |
| 1949d1e | feat(command-map): add scheduling decision intelligence（M05 客户端） |
| ac71080 | fix(scheduler): emit replan.suppressed sse event on storm guard |
| 8a1cb55 | docs(scheduler): add incremental replan v2 design |

## 3. 完成范围

| 能力 | 状态 | 说明 |
|---|---|---|
| Regression Baseline | ✅ | constraint-loader lint + openapi:no-drift 根因修复，全检查通过 |
| Incremental Replan | ✅ | analyzeImpactV2 + partialSnapshot（affected ∪ frozen）+ conflict batch |
| ReplanImpact | ✅ | 全可选字段契约（trigger/affected×6/frozen/movable/reasons/snapshot/baseline） |
| Frozen/Affected Set | ✅ | executing/dispatched/in_progress/LOCK/safety 冻结；无关任务不入子图（不变量测试） |
| Impact Propagation | ✅ | impact-propagation.ts 纯函数：BFS 闭包、depth≤3、maxAffected=200、确定性 |
| Churn Optimization | ✅ | Churn V2 七项罚入评估器/候选评分/双 solver，缺省=现状回归 |
| Replan Preview | ✅ | ReplanPreviewService readonly + POST /replan/preview + 8 项 Delta |
| Conflict Debounce | ✅ | 风暴守卫（debounce/interval/window）+ 抑制计数 + SSE suppressed |
| Decision Cockpit | ✅ | TaskIntelligencePanel + RejectedCandidateExplain + replanOverlayVM |
| Candidate Explanation | ✅ | decisionExplainVM 消费服务端 DecisionTrace，前端禁重算（源级断言） |
| Replan Diff Visualization | ✅ | changed-by-replan + human-locked 图层 + entityColors 调色板 |
| What-if / Plan Compare | ✅ | PlanComparePanel 接入 ReplanPreview + Delta 摘要 |
| Prediction Shadow | ✅ | ShadowEvaluatorService（MAE/RMSE/P50/P95/calibration/fallback/coverage） |
| Canary Readiness | ✅ | canaryFractions [0,5%,20%,50%,100%] + autoRollback 判定 |
| Refactor | ⚠️ 未做 | strangler 拆分为 M05 可选项，优先行为不变+测试全绿（已完成 4-7 全部内容） |

## 4. 修改文件（48 文件，+6247/-221）

### shared
- `ewoh-spark-app/shared/scheduler.ts`（+214）：ReplanImpact / ReplanConfig / ReplanApprovalConfig / ChurnConfig / PredictionConfig / ReplanPreviewResult / ReplanPreviewRequest / ReplanApprovalDecision / PredictionShadowSample / PredictionShadowAggregate / SchedulerKpiSnapshot.stability 6 项可选 KPI

### server（scheduler 模块）
- 新增：`impact-propagation.ts`、`replan-preview.service.ts`、`prediction/shadow-evaluator.service.ts`、`__tests__/impact-propagation.spec.ts`、`replan-v2-impact.spec.ts`、`replan-storm.spec.ts`、`candidate-engine-parity.spec.ts`、`replan-preview.service.spec.ts`、`replan-kpi.spec.ts`、`prediction/__tests__/shadow-evaluator.spec.ts`
- 修改：`replan-coordinator.service.ts`（analyzeImpactV2/风暴守卫/conflict batch/KPI/SSE suppressed）、`impact-analyzer.ts`（analyzeV2/buildSeed）、`conflict.service.ts`（aggregateOpenConflicts）、`scheduling-policy.service.ts`（replan/replanApproval/churn 缺省+访问器）、`scheduler-metrics.service.ts`（6 项 KPI 记录）、`kpi.service.ts`（stability 聚合）、`scheduling-objective-evaluator.service.ts`（Churn V2 七项罚）、`candidate-engine.service.ts`（churn 评分）、`heuristic-scheduling-solver.ts`（#17 接线+churn）、`cp-sat-scheduling-solver.ts`（churn 透传）、`plan.service.ts`（listActivePlans+consultReplanApproval）、`scheduler.controller.ts`（POST /replan/preview）、`scheduler.service.ts`（AUTO/HUMAN 编排）、`scheduler.module.ts`（注册 2 服务）、`scheduling-feedback.service.ts`（actual 回填）、`__tests__/scheduling-objective-evaluator.spec.ts`（缺省回归快照+churn 生效）

### client（CommandMap）
- 新增：`panels/TaskIntelligencePanel.tsx`、`panels/RejectedCandidateExplain.tsx`、`replanOverlayVM.ts`、`vm/decisionExplainVM.ts`、`replan-overlay-vm.test.ts`、`panels/decision-cockpit-render-only.test.ts`
- 修改：`entityColors.ts`（replanChangeColor/HUMAN_LOCKED）、`layers/SchedulerLayers.tsx`（ReplanChangeLayer+HumanLockedLayer）、`hooks/commandMapSelector.ts`、`panels/PlanComparePanel.tsx`（ReplanPreview 接入）、`client/.design-token-allowlist.json`、`client/src/types/openapi.d.ts`

### openapi / contracts / docs
- `openapi/ewoh.yaml`（+445：ReplanPreview 端点+schemas）、`openapi/route-manifest.json`（322/479）、`contracts/events/event-catalog.yaml`（replan.approval_required/suppressed）、`docs/scheduler-commandmap-upgrade/08-incremental-replan-v2-design-2026-08-10.md`（新增）

## 5. 数据模型变化

- 接口（全可选字段，向后兼容，无 DB migration）：ReplanImpact / ReplanPreviewResult / ReplanApprovalDecision / PredictionShadowSample / PredictionShadowAggregate / ReplanConfig / ReplanApprovalConfig / ChurnConfig / PredictionConfig
- KPI：SchedulerKpiSnapshot.stability 新增 6 项（affectedAssignmentRatio / unchangedAssignmentRate / scheduleChurn / replanDuration / replanTriggerCount / replanSuppressedCount）
- 事件：replan.approval_required、replan.suppressed（event-catalog 登记，34 msg/34 channel）
- snapshot 字段：无新增（ReplanImpact 为运行时模型，不落 snapshot）

## 6. API 变化

| method | path | request | response | 兼容 |
|---|---|---|---|---|
| POST | /api/scheduler/replan/preview | { triggerType, triggerIds? } | ReplanPreviewResult | 新增端点，不破坏既有 |

- 既有端点全部保持不变（向后兼容）；route-manifest 322/479，0 undocumented / 0 unimplemented。

## 7. 架构变化（最终调用链）

```
Event/Trigger → ReplanCoordinatorService.handleTrigger
  → 风暴守卫（按 org LRU：debounce/minInterval/maxWindow）→ suppressed（SSE replan.suppressed）
  → WorldStateService.buildSnapshot
  → ImpactAnalyzer.buildSeed + impact-propagation.propagateImpact（确定性闭包）
  → partialSnapshot（affected ∪ frozen；无关任务不入子图）
  → SolverService.solveVariants
      ├─ CandidateEngineService.buildCandidatePool（#17 接线，parity 测试）
      ├─ HeuristicSchedulingSolver（Churn V2 七项罚入评分）
      └─ CpSatSchedulingSolver（同一契约 + churn 透传）
  → SchedulingObjectiveEvaluator（统一评估 + Churn V2，缺省=现状）
  → consultReplanApproval（AUTO_REPLAN / HUMAN_APPROVAL_REQUIRED → SSE approval_required + ReplanPreview）
  → PlanService.persistPlan（唯一写路径，事务内）
  → Dispatch/Reservation（capacity 预检不变）
  → SchedulerMetrics/KpiService（6 项 Replan KPI）
  → ShadowEvaluatorService（PredictionShadowSample，feedback 回填 actual，canary 判定，advisory-only）
  → SSE → CommandMap（TaskIntelligencePanel / RejectedCandidateExplain / ReplanChangeLayer / HumanLockedLayer / PlanComparePanel）
```

## 8. 测试（QA 独立复跑）

| 类别 | 结果 |
|---|---|
| Server tests（scheduler） | ✅ 64 suites / 468 tests |
| Client tests | ✅ 95 suites / 726 tests |
| TypeScript（server+client） | ✅ 0 错误 |
| Lint（eslint+tsc+stylelint+design-tokens） | ✅ |
| OpenAPI | ✅ no-drift + route audit --strict（322/479, 0/0） |
| contract:events | ✅ 34 msg / 34 channel |
| Replan 不变量（Phase 9，17+6 项） | ✅ 全部有测试证据 |
| Tenant（replan-storm orgA/B + rls-org-filter + shadow org 隔离） | ✅ |
| Concurrency（reservation-concurrency） | ✅ |
| Realtime（SSE 单例/事件/gap） | ✅ 既有测试保持 |
| E2E（浏览器） | ⚠️ 未跑（需真实 PG 全链 migration 前置，既有 playwright 配置存在；非本轮引入） |
| Golden Replay（solver-fixtures 14 场景） | ✅ |

## 9. KPI / 性能

- 新增 6 项 Replan KPI 已实现并聚合（数值依赖生产运行数据，本轮测试环境无真实运行）：NOT MEASURED
- candidate generation / solver duration P50/P95/P99 / SSE lag / prediction latency：NOT MEASURED（无性能压测环境；既有 perf 脚本存在，未在本轮执行）

## 10. 安全验证

| 项 | 结果 |
|---|---|
| hard constraint violations | ✅ 0（hard-constraints 15 类 + solver-invariants） |
| double booking | ✅ 0（capacity-aware + reservation-concurrency，23P01→409） |
| cross-org leakage | ✅ 0（rls-org-filter.audit + replan-storm org 隔离 + shadow org 隔离） |
| safety constraints | ✅ SAFETY_EVENT/ZONE_RESTRICTED → HUMAN_APPROVAL_REQUIRED + safetyBlocked fail-closed |
| Edge advisory-only 边界 | ✅ 未破坏（run.py 默认 advisory_only=True，_assert_writable 拦截写路径） |
| NestJS 唯一写权限 | ✅ 所有写仍经 ReplanCoordinator/PlanService 事务；preview 一律 readonly |

## 11. 未解决事项

| # | 项 | 原因 | 影响 | 后续最小动作 |
|---|---|---|---|---|
| 1 | Command Map 浏览器 E2E 未跑 | 需真实 PG 全链 migration（001-017+users+admin seed）前置 | 无（23 项单元/集成验收全过） | 部署环境跑 `playwright.commandmap.config.ts` |
| 2 | strangler 拆分（CommandMap 1159 行等） | M05 设计中为可选项，优先行为不变+测试全绿 | 无（面板已按领域拆分） | 后续按 08 设计 §10 渐进抽 hooks/renderer |
| 3 | 性能基线（solver P50/P95/P99 等） | 无压测环境 | 无功能影响 | 部署环境跑 perf 脚本采集 |
| 4 | repo-facts.spec.ts 失败（历史无关） | schema-manifest managed_count=73 vs state.json 57 制品口径不一致（abdaab5 起存续，两文件未触碰） | 全量 server 测试 1037/1038 | 制品对齐（超出本任务范围） |
| 5 | 既有 CommandMap 双 SSE 连接（memory 遗留） | 页面级单例已成立（路由隔离），应用级提升需壳布局改造 | 无（当前路由不同屏渲染） | 未来可将 Provider 提升到 app 根部 |

---

*以上为最终交付报告。全部提交已推送 origin/main，工作区仅剩任务无关的 .trae 修改（未触碰）。*
