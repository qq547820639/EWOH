# Checklist（代码深化 + 规模性能 + Decision Cockpit UX + Production Closure）

> 基线 `main` @ `9283b8b`。以真实代码/测试/构建/可运行行为验证为准；真实环境不可用项诚实标 BLOCKED。
> 交付证据见 [docs/reviews/deepen-scale-cockpit-closure-report.md](../../../docs/reviews/deepen-scale-cockpit-closure-report.md)。

## Task 0 事实基线
- [x] 环境指纹已记录（branch/HEAD/time/OS/Node/Python/缺失工具）
- [x] 六维事实矩阵文档已产出（docs/reviews/deepen-scale-fact-baseline.md）
- [x] delivery/ 冻结、ui/command_map/ 归档、output/release 不作为事实源已确认
- [x] 既有可运行门禁基线已运行并记录

## Task 1 Scheduler 大规模性能
- [x] before 基线 10/100/500/1000 已复现并记录（10=4.82ms/100=200.57ms/500=32.5s/1000=OOM exit 134）
- [x] 热点已 profiling 并定位（候选枚举/route 75 万次调用/station/trace 全量构造）
- [x] staged candidate generation 已实现（7 阶段 pipeline）
- [x] run-local indexes + RouteCost/TravelCost 确定性 memoization 已实现（75 万次 estimate→≤64 唯一计算）
- [x] explanation trace 已改 compact rejection code（CompactReject + 有界缓冲 + rejectedHardTotal）
- [x] incremental replan fast-path 已实现（reuseBaseline 默认 OFF，复验后采纳/回退）
- [x] 语义保持回归全过（12 oracle spec 81 tests + 全 suite 655 tests）
- [x] 永久 benchmark 支持 10/100/500/1000；500=1.64s（<5s）✅ / 1000=8.5s（<10s）✅ / 不 OOM ✅
- [x] benchmark 已接入 CI（perf.yml scheduler-benchmark-gate）

## Task 2 Strangler Refactor
- [x] characterization tests 已补齐（scheduler-facade-characterization.spec.ts 56 tests）
- [x] scheduler.service.ts 已拆分 7 个职责服务，原文件降级 facade（2288→398 LOC）
- [x] heuristic solver 已拆分（Task 1 staged pipeline，CandidateEnumerator/FeasibilityEvaluator/Scorer/Trace 语义）
- [x] 行为快照不变：全量 scheduler spec（655）+ tsc 通过

## Task 3 多租户/RLS
- [x] 11 张表定性分类完成（GLOBAL_SHARED/TENANT_SCOPED/DERIVED_TENANT_OWNERSHIP）
- [x] 正式 ADR 已产出（ADR-004-scheduler-tenancy.md）
- [x] TENANT_SCOPED 双保险已核验（RLS + 应用层 + GUC app.current_org_id）
- [x] child table 数据库级 tenant boundary 可验证（standalone_028 派生 org trigger + verify）
- [x] PostgreSQL multi-tenant E2E 已实现（verify-scheduler-multitenant.mjs；CI 接线；本地 BLOCKED）
- [x] service_role 行为测试已覆盖（rls-policy + rls-org-filter 10/10）

## Task 4 CommandMap Store
- [x] useCommandMapController + CommandMapStore（6 slices）已实现
- [x] selection 唯一状态源；无 `plans[0]` 隐式 fallback（client/src grep=0）
- [x] SSE 单事件局部更新，不全量 rerender（slice 隔离测试）
- [x] viewport culling / layer memoization / list virtualization / progressive rendering 已落地
- [x] 纯展示转换 Web Worker：跳过并记录原因（无既有 worker 模式）；业务规则未复制到客户端

## Task 5 Decision Cockpit 与 Freshness
- [x] 统一 Decision Context（9 元素 + ACTIONS）已实现，复用既有能力，前端不重推业务规则
- [x] "Why did this task move?" 因果链 + unchanged-task 展示已实现
- [x] 全局 Data Freshness Model + 顶部 indicator 已实现；SSE 断开不呈现 LIVE（测试）
- [x] Solver 状态链（CP-SAT requested → UNAVAILABLE/TIMEOUT/FALLBACK → Heuristic fallback）显式展示
- [x] 既有面板能力全部保留

## Task 6 CP-SAT Activation
- [x] worker 运行级能力已补齐（并发/超时/规模/内存/metrics/correlation ID/优雅停机）
- [x] SHADOW 双跑对比指标已实现，shadow 结果不可 dispatch/approve/reserve（isShadow + ShadowPlanGuard）
- [x] CANARY（确定性采样 + budgets + auto/manual rollback）已实现；hard divergence 自动回退 heuristic
- [x] productionEnabled 恒 false（feature-status.yaml 如实 + ACTIVATION_LADDER 注释）
- [x] 本机无 ortools 环境如实 UNAVAILABLE/fallback（28 python + 17 TS tests）

## Task 7 Shadow Learning 持久化
- [x] prediction_shadow_observation migration（standalone_029：18 列/3 索引；apply/verify/rollback/re-apply 注册）
- [x] 持久化写路径 + backfill 优先 correlation id/taskId/executionId
- [x] 评价聚合（MAE/RMSE/p50/p95/coverage/fallbackRate/calibration/modelVersion/site-org/rolling window）
- [x] 重启后历史保留（持久化语义测试）；advisory-only 语义保持

## Task 8 Runtime Gates
- [x] kind ephemeral 集群 Helm 全链路 CI job（helm-kind-gate，30min 硬上限；本地 BLOCKED）
- [x] Canary 注入失败自动回滚 CI job（helm-kind-gate 内；本地 BLOCKED）
- [x] Soak/load（硬上限）CI job（soak-load-gate 25min + soak-scheduler-events.js 240s 兜底；本地 BLOCKED）
- [x] docs/runtime-gates.md 状态已更新（G5/G8/G9→CI 自动化）；无伪造 PASS

## Task 9 Edge 模块化
- [x] 8 个 route domain 已提取；routing/serialization/auth/invocation/lifecycle 已分离
- [x] 无大型 Web Framework；HTTP/SSE 契约兼容（characterization 23 tests + 实网 spot-check）
- [x] Python pytest 全绿（799 passed）

## Task 10 Feishu Sidecar
- [x] 既有 async execFile/timeout/breaker 未重复实现（确认）
- [x] 审计项已闭环或如实标记（retry jitter/backoff 新、queue 上限新、分页修、凭据统一、关停排空修、幂等核实）
- [x] 单实例边界已写入部署/运行时契约（README 七节 + docs/operations/feishu-sidecar-runtime.md）

## Task 11 Repository Truth Gate
- [x] feature-status.yaml 已建立（cpSat/predictionShadow 如实 false）
- [x] CI 校验已实现（truth-feature-status.js R1-R7：manifest/生产门禁/文档/OPEN-DECISIONS/版本/CP-SAT 漂移/OpenAPI）
- [x] README/CHANGELOG/OPEN-DECISIONS 漂移已同步修正（README 核实无需改；CHANGELOG/OPEN-DECISIONS/route-manifest/state.json 已修）

## Task 12 验收与交付
- [x] 全部可运行验收命令执行并记录（server 655 / client 832 / python 971+10 / feishu 54 / openapi / audit-repo-facts 39/39 / truth-gate 24/24 / benchmark before→after；DB/Helm/CP-SAT 真求解 BLOCKED+命令）
- [x] 交付报告已产出（docs/reviews/deepen-scale-cockpit-closure-report.md，15 项交付要素）
- [x] CHANGELOG / ADR / feature-status / runtime-gates 已更新
- [x] 提交并推送 `origin/main` 成功；工作树干净（用户既有未提交改动除外）；无调试残留；无 TODO/stub/fake success 新增
