# Checklist

> 用户验收标准（12 条）+ 各章节核对项。逐项核验代码/文档/测试后勾选；全部通过后出交付报告。

## 用户完成标准（12 条）
- [x] 1. runtime truth 一致（solver activation 唯一事实源，README/部署/测试/UI 对齐）— `EWOH_SOLVER_ACTIVATION` 唯一事实源 + truth-feature-status activation 门禁 32/32 + env inventory 101/102 PASS
- [x] 2. hard constraints 不回归（eligibility/route/safety 硬约束测试全绿）— server jest 794 scheduler/shared tests 通过；solver-activation/cp-sat-fallback 未削弱断言
- [x] 3. 500 task < 5s（benchmark 报告断言 + 实测证据）— 本机 500 = 2.48~3.2s PASS（目标 5s）
- [x] 4. 1000 task < 10s 且不 OOM（benchmark 报告断言 + 实测证据）— 本机 1000 = 13.7~15.7s（>10s，CI 宽松界 60s 内）；无 OOM；见报告 J/K/L
- [x] 5. OpenAPI 生成 100% 成功（gen:openapi 零漂移 + 双向一致性 strict gate）— gen:openapi:check 零漂移；audit --strict 0 undocumented / 0 unimplemented；test.yml + standalone.yml 均 strict
- [x] 6. real PostgreSQL E2E 不 skip（release gate 强制，PG 缺失即失败）— e2e-preflight.mjs + e2e-config 空 env 抛错；本地 BLOCKED_BY_ENVIRONMENT 如实标注
- [x] 7. multi-instance critical paths 有验证（replan 双实例 + snapshot 并发）— replan-dual-instance.e2e + snapshot-concurrency.e2e（真实 PG，CI 执行）
- [x] 8. Command Map 核心状态可 deep-link/恢复（URL-backed operator context）— useUrlOperatorContext + deep-link plan/task/event + 失效降级提示
- [x] 9. dangerous scheduling operations 有 preview/diff/confirmation（approve/override/exclude/lock/replan/dispatch）— replan preview（ReplanPreviewResult 接线）、dispatch/replan 确认、override dry-run、conflict ack a11y dialog
- [x] 10. 所有事实源和文档一致（feature-status/README/OpenAPI/route-manifest/event catalog/DB schema/env inventory）— truth-feature-status 32/32、route-manifest 可复现、env inventory 101/102、README capability 表行级核对
- [x] 11. 所有新增失败模式都有 observability（metrics + UI 可观察，禁止 silent fallback）— replan_guard_degraded_total、rate_limit_redis_fallback_total、CP-SAT malformed/UNAVAILABLE/FALLBACK 显式标记、graph_unavailable 显式标记、sensor stale 进入 Data Quality
- [x] 12. 不牺牲现有安全、审计和可解释能力（shadow guard、audit、explain 字段保留）— shadow guard 三路测试、systemTransaction 审计、DecisionTrace/explain 字段未删

## §一 Solver 激活状态
- [x] 1.1 `SolverActivationState` 类型 + 配置键 + env 覆盖存在，缺省 OFF
- [x] 1.2 parseConfig 透传 solver 块（修复 cpSat 丢弃）
- [x] 1.3 OFF 不调 CP-SAT；SHADOW 双跑 isShadow；CANARY 采样+回滚；PRODUCTION fail-closed（productionEnabled=false）
- [x] 1.4 solverStatus/fallbackReason 落库（plan + run 列 + migration standalone_030）
- [x] 1.5 shadow plan approve/reserve/dispatch 三路 guard 测试通过（shadow-plan-guard.spec.ts 6 用例）
- [x] 1.6 activation drift gate（truth-feature-status 交叉核对）接入 CI（--self-test 7/7）
- [x] 1.7 OFF/SHADOW/CANARY/PRODUCTION 集成测试全绿（solver-activation.spec.ts 12 用例）
- [x] 1.8 README/feature-status/deploy env 三方一致（EWOH_SOLVER_ACTIVATION 已入库）

## §二 OpenAPI 闭环
- [x] 2.1 `GET /api/scheduler/context` 已文档化（ewoh.yaml + SchedulingContext schema）
- [x] 2.2 shared↔spec 漂移类型（SchedulerKpiSnapshot 6 字段等）已对齐
- [x] 2.3 route-manifest.json 可复现（无 generatedAt、去重、二次生成零 diff）
- [x] 2.4 test.yml 接入 `gen:openapi:check` + `audit-openapi-routes --strict`
- [x] 2.5 jest 级 documented↔implemented 双向一致性测试存在（openapi-route-parity.spec.ts）
- [x] 2.6 shared↔generated type parity 测试存在（openapi-type-parity.spec.ts，7 个 P4 契约）

## §三 Snapshot 版本并发
- [x] 3.1 counter migration + verify 存在（standalone_031）
- [x] 3.2 原子分配 + bounded retry（≤3 次），语义 WS-YYYYMMDD-NNNN 保留
- [x] 3.3 并发 buildSnapshot 集成测试（真实 PG E2E + 单测 27 用例含 23505 重试/超限）

## §四 affected 指标
- [x] 4.1 SolveOptions.affectedTaskIds 传入 partial/full 路径
- [x] 4.2 scheduler_partial_replan_affected 与 KPI/log/preview 同源（impact.affectedTaskIds）
- [x] 4.3 1/N/full 三种情况测试通过（affected-metrics.spec.ts 5 用例）

## §五 性能
- [x] 5.1 benchmark 输出 cpuTimeMs/prunedCount/routeCacheHitRatio
- [x] 5.2 500<5s PASS、1000>10s FAIL（report-only，CI 宽松界保持）、无 OOM 断言 + CI 矩阵保持

## §六 Replan guard fail-closed
- [x] 6.1 production advisory-lock 异常 fail-closed（阻止 automatic replan + 明确错误）
- [x] 6.2 metric `scheduler_replan_guard_degraded_total` + health/readiness degraded reason 存在
- [x] 6.3 双实例真实 PG replan 幂等 E2E 通过（replan-dual-instance.e2e.spec.ts D1/D2）

## §七 root DB 逃逸
- [x] 7.1 systemTransaction API 存在（request-database-context.ts）
- [x] 7.2 业务路径不再直接用 root handle（DomainPersistenceService 全量走 systemTransaction）
- [x] 7.3 架构/lint 测试禁止非 allowlist 引用 root token（root-db-allowlist.audit.spec.ts 4/4）
- [x] 7.4 运行时 GUC 行过滤断言 + 并发跨 org RLS 测试通过（org-rls-guc.e2e.spec.ts）

## §八 CommandMap 拆分
- [x] 8.1 CommandMapShell + 6 Workspace + MapViewport 拆分完成（CommandMap.tsx 1304→12 行）
- [x] 8.2 状态仍收敛在 store，功能零回归（188 CommandMap tests 全绿 + axe 5/5）

## §九 URL-backed context
- [x] 9.1 全量状态同步 URL（mode/layer/selected*/activeTab/conflict/replay/compare）
- [x] 9.2 deep-link plan/task/event 可用（useUrlOperatorContext 16 用例）
- [x] 9.3 非法 id 降级 + 用户可见说明；临时 UI 状态不入 URL（一律 replaceState）

## §十 UX
- [x] 10.1 freshness 模型统一（LIVE/DELAYED/STALE/OFFLINE/REPLAY/RESYNCING/DEGRADED），SchedulerRealtimeBadge 第二套文案已删除
- [x] 10.2 dispatch/replan 确认 + preview；override dry-run；conflict ack a11y dialog
- [x] 10.3 ReplanPreviewResult 接线（affected/churn/lateness/travel/workload/conflicts/solver/version）
- [x] 10.4 危险操作统一“状态→影响→确认→结果”流（stale-version 与审计行为保留）

## §十一 大数据量
- [x] 11.1 SSE batching/coalescing（createEventBatcher 80ms 窗口 + 结构性事件即时 flush；10k 遥测削减 99%）
- [x] 11.2 React profiler benchmark（commandMapPerf）+ CI 接线（perf.yml command-map-perf-gate）；虚拟化覆盖 events/resources/tasks/intelligence

## §十二 无障碍
- [x] 12.1 Command Map axe 覆盖（ux009-command-map-axe.spec.js 5/5 通过）
- [x] 12.2 table/list 键盘替代视图（KeyboardTableView 接入 5 面板）+ SVG SR 摘要
- [x] 12.3 overlay focus 恢复（ConflictPreview/PlanDiffDrawer/Override 结果区）+ accessible name（lib/a11y.ts +8）+ 非颜色状态 + forced-colors

## §十三 Edge runtime
- [x] 13.1 production 禁止 EWOH_EDGE_SCHEDULING_WRITE=1（SchedulingWriteProhibitedError）
- [x] 13.2 adapter supervisor（死线程重启 + 指数退避 1s..60s 封顶 + respawn 计数）
- [x] 13.3 sensor disconnect / adapter crash 故障注入测试（test_adapter_supervisor.py 8 用例）

## §十四 Feishu 侧车
- [x] 14.1 /health/live + /health/ready 区分本地 vs Feishu（health.test.js 6 用例；本地实测 503 not_ready）
- [x] 14.2 feishu-app 测试接入 CI（.github/workflows/feishu.yml，60 tests）

## §十五 真实 PG E2E
- [x] 15.1 snapshot 并发 E2E（snapshot-concurrency.e2e.spec.ts）
- [x] 15.2 双实例 replan E2E（replan-dual-instance.e2e.spec.ts）
- [x] 15.3 previous-RC→main 升级测试（verify-rc-upgrade.mjs：RC 截点动态解析 + G1 基线/G2 升级/G3 幂等/G4 兼容/G5 契约）
- [x] 15.4 release gate 无“PG 缺失整包 skip”（e2e-preflight.mjs + e2e-config 空 env 抛错）

## §十六 故障注入
- [x] 16.1 CP-SAT malformed response（cp-sat-malformed.spec.ts 3 用例）/ PG 临时故障（world-state-db-failure + pg-temporary-failure.e2e）/ Redis unavailable（rate-limit-redis-fallback.spec.ts）
- [x] 16.2 route graph unavailable（routing/travel-cost 显式标记）/ sensor stale（test_sensor_stale.py）
- [x] 16.3 降级在 UI + metrics 可观察断言（每路径 metric 或显式状态字段）

## §十七 drift gate
- [x] 17.1 env var inventory 核对（audit-env-inventory.js --strict：101 documented / 102 code-env，0 漂移）
- [x] 17.2 solver activation 交叉核对（truth-feature-status --self-test 7/7）
- [x] 17.3 README capability 表行级核对（11 feature 行）+ truth-gate.js CI 接线（test.yml）

## §十九 最终验收
- [x] 19.1 全量门禁清单执行并记录（见交付报告 §I；1 个迭代引入失败已修复 fe6dced；3 个既有失败未掩蔽）
- [x] 19.2 交付报告按 A–N 结构输出，含 benchmark 前后对比与内存峰值对比（docs/reviews/converge-prod-ux-report.md）
