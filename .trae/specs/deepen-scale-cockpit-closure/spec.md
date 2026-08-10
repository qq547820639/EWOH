# 代码深化 + 规模性能 + Decision Cockpit UX + Production Closure — Spec

> 基线：`main` @ `9283b8b`（2026-08-10 15:15:27 +0800）。环境：macOS，Node v26.5.1，Python 3.9.6；
> 无 Docker / psql / Helm / kubectl / kind / k3d（真实 PG、容器、集群门禁本地 BLOCKED，可在 GitHub Actions 尝试自动化）。
> 原则：以源码 + 测试 + CI 为事实源；不重复实现已在 main 完成的能力；不做大爆炸 rewrite；
> 数据库改动必须 apply/verify/rollback/re-apply 可往返；性能优化必须保持调度语义；
> 前端绝不复制服务端调度规则；环境无法运行的门禁如实标 BLOCKED，不伪造 PASS。

## Why

EWOH 上一阶段（scheduler-phase0/phase1、prod-convergence、code-deepening-ux-closed-loop）已把
调度闭环、RLS 主体、UX 状态模型、性能预算等建立起来。但当前 main 仍存在以下未闭环风险：

1. Scheduler 大规模不可用：候选枚举近似 O(T×P×D×S)，500 tasks ≈ 46s、1000 tasks OOM 的旧基线
   尚未被系统性复现、profiling 与消除；无永久 10/100/500/1000 benchmark 基线。
2. `scheduler.service.ts`（2287 LOC / 44 方法）与 `heuristic-scheduling-solver.ts`（1154 LOC 内联枚举）
   仍是巨石，性能热点无法对应明确阶段，难以独立测试。
3. 多租户边界：8 张 scheduler 表已 RLS，但 outbox / world_state_snapshot / assignment_event 的设计
   原因只写在 migration 注释里，无正式 ADR；child table 的 derived tenant ownership 缺少数据库级可验证
   约束；缺真实 PostgreSQL 的 Org A / Org B 隔离 E2E 与 service_role 行为测试。
4. CommandMap 仍是大规模 orchestration component，selection 缺少唯一状态源，SSE 事件可能触发全量 rerender。
5. 多个解释类面板（ConflictCenter / TaskIntelligence / RejectedCandidateExplain / ReplanPreview /
   PlanCompare / Override）未收敛为统一 Decision Context；缺少 "Why did this task move?" 因果链与
   unchanged-task 证明；solver fallback（CP-SAT requested → UNAVAILABLE → heuristic）只藏在 debug metadata。
6. CP-SAT worker/adapter/fallback 已实现，但 OFF→SHADOW→CANARY→PRODUCTION 激活流程未闭环，
   worker 的运行级硬能力（timeout/内存/并发/优雅停机/指标/correlation ID）未全部落实。
7. ShadowEvaluator 仅内存环形缓冲（MAX_SAMPLES_PER_ORG=1000），actual backfill 靠
   (predictionType, createdAt) 模糊匹配，重启即丢；无持久化 observation、无长期评价指标。
8. Helm install/upgrade/rollback、canary 回滚、long soak/load 仍 BLOCKED，未尝试 ephemeral kind/k3d。
9. src/edge_platform/server.py（1692 LOC 单 Handler）与 Feishu sidecar 仍有 P2 审计项；
   README/CHANGELOG/OPEN-DECISIONS 与实际代码存在事实源漂移，无统一 feature-status manifest。

## What Changes

- **P0 规模性能**：用现有 [benchmark-scheduler.ts](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/scripts/benchmark-scheduler.ts)
  复现 10/100/500/1000 基线 → CPU/heap/候选数/拒绝数/route/station 调用 profiling → 候选生成改为 staged
  pipeline（skills prefilter → availability index → capability/status index → spatial/station prefilter →
  reservation prefilter → Top-K bound → expensive route/scoring → deterministic ranking），对 unchanged
  task / unaffected subgraph 走增量 fast-path；RouteCost/TravelCost 本 run 确定性 memoization；
  explanation trace 改 compact rejection code，UI 需要时再 materialize；保持合法语义不变（parity/invariant 回归）。
- **P0 Strangler Refactor**：先补 characterization tests，再按职责从 `scheduler.service.ts` 抽取
  SchedulerRunOrchestrator / SchedulerQueryService / SchedulerPlanApplicationService /
  SchedulerReplanApplicationService / SchedulerConstraintApplicationService /
  SchedulerEventApplicationService / SchedulerDispatchApplicationService，原文件退化为 facade；
  `heuristic-scheduling-solver.ts` 拆分 CandidateEnumerator / FeasibilityEvaluator / AssignmentScorer /
  StationAllocator / ResourceAllocator / TraceCollector / SolutionAssembler。
- **P0 多租户/RLS**：对 9 张表逐一明确 GLOBAL_SHARED / TENANT_SCOPED / DERIVED_TENANT_OWNERSHIP 并形成 ADR；
  TENANT_SCOPED 补齐 schema/org_id/index/RLS/应用层过滤/request GUC 双保险；child table 增加数据库级
  可验证约束（如 plan ownership 派生）；新增真实 PostgreSQL multi-tenant E2E（Org A 创建，Org B 不可
  list/get/update/delete/approve/dispatch；service_role 预期行为）。
- **P1 CommandMap 治理**：抽取 useCommandMapController + CommandMapStore（selection/viewport/mode/replay/
  scheduler-realtime/decision-context slices），selectedTaskId/selectedPlanId/selectedEntityId 唯一状态源，
  禁止 `plans[0]` 等隐式 fallback；selector/memoization、viewport culling、list virtualization、
  progressive rendering；SSE 增量更新不全量 rerender。
- **P1 Decision Cockpit**：保留既有面板能力，新增统一 Decision Context（WHAT HAPPENED / WHY / IMPACT /
  SYSTEM DECISION / WHY THIS ASSIGNMENT / WHY NOT OTHERS / COST / RECOMMENDED ACTION / ACTIONS），
  复用 ReplanImpact/PlanAssignmentDiff/DecisionTrace/CandidateExplain/Conflict/SchedulingFeedback；
  新增 "Why did this task move?" 因果链与 unchanged-task 展示；新增全局 Data Freshness Model
  （LIVE/DELAYED/STALE/OFFLINE/REPLAY/SHADOW + lastUpdatedAt/source/lag/reason）与 CommandMap 顶部
  freshness indicator；solver 状态链（CP-SAT requested → UNAVAILABLE → Heuristic fallback）在方案详情
  显式展示，不只藏于 debug metadata。
- **P1 CP-SAT Activation**：在既有 worker/adapter/fallback 基础上落实 worker 运行级能力（health/readiness、
  timeout、max problem size、memory limit、concurrency limit、graceful shutdown、structured metrics、
  request correlation ID）；补齐 SHADOW（同 snapshot/policy 双跑对比指标，结果不得 dispatch）与 CANARY
  （按 org/site 确定性采样 + canary fraction / error budget / timeout budget / fallback threshold /
  invariant violation auto rollback / manual rollback），任何 hard constraint divergence 立即回退
  heuristic；runtime gate 达标前 productionEnabled 恒为 false。
- **P1 Prediction Shadow Learning 持久化**：新增 durable observation 模型
  （prediction_shadow_observation：id/org_id/prediction_type/entity|task id/prediction/baseline/actual/
  confidence/model_version/policy_version/snapshot_version/created_at/actual_at/absolute_error/relative_error/
  correlation_id），backfill 以 correlation id/taskId/executionId 优先；migration apply/verify/rollback/
  re-apply + indexes + retention；评价指标 MAE/RMSE/p50/p95/coverage/fallbackRate/calibration/
  modelVersion 对比/site-org 对比/rolling window；内存 ring buffer 保留为 fast cache 但非唯一事实源；
  Prediction 仍 advisory-only，production activation 前不改变正式调度结果。
- **P1 Runtime Gates**：在 GitHub Actions 尝试 ephemeral kind/k3d 真实执行 Helm install/health/smoke/
  upgrade/failed-upgrade/rollback/post-rollback、canary 注入失败回滚、soak/load（含 scheduler event
  storm / SSE reconnect / outbox / PG pool / memory growth / prediction samples / feishu queue / edge
  backlog-replay），所有项设置硬上限与超时，CI 无界即失败；本地环境无法执行项标 BLOCKED 并保留一键脚本。
- **P2 Edge server 模块化**：按 route domain（health/status、auth、telemetry、inference、world、
  scheduler、admin/config、replay）从 server.py 提取模块，分离 routing/serialization/auth-middleware/
  service-invocation/lifecycle；保持 HTTP/SSE 契约完全兼容；补 characterization tests；保持零/极少
  运行时依赖（不引入 Web Framework）。
- **P2 Feishu sidecar 审计**：确认既有 async execFile + timeout + breaker 不重复实现；审计 SQLite
  多实例边界、webhook/sync pagination、telemetry batching、queue pressure、credential exposure、
  audit completeness、graceful shutdown、retry jitter/backoff、跨重启幂等；单实例边界写入
  deployment/runtime contract（不无意义迁移 PostgreSQL）。
- **P2 Repository Truth Gate**：新增统一 feature-status.yaml（implemented/tested/deployable/
  productionEnabled/runtimeVerified/docsUpdated/evidence），CI 自动校验 OPEN-DECISIONS resolved 状态、
  docs production-ready 声明必须有 runtime evidence、OpenAPI route manifest 零漂移、version/README/
  release tag 语义、generated TS contracts 可重新生成且 git diff 为 0。

## Impact

- 受影响规格能力：Scheduler 性能与可维护性、多租户隔离、CP-SAT 激活流程、Prediction Shadow Learning、
  CommandMap UX / Decision Cockpit / Data Freshness、Runtime Gates、Edge 模块化、Feishu sidecar、
  Repository Truth Gate。
- 受影响代码（主要）：
  - `ewoh-spark-app/server/modules/scheduler/`（solver/候选生成/scheduler.service 拆分/RLS/持久化/
    CP-SAT/shadow）、`ewoh-spark-app/scripts/benchmark-scheduler.ts`、`ewoh-spark-app/package.json`。
  - `db/migrations/standalone_0NN_*`、`db/verify/standalone_0NN_*.sql`、`db/contracts/schema-manifest.yaml`。
  - `ewoh-spark-app/client/src/pages/CommandMap/`、`client/src/components/*`、`client/src/api/scheduler.ts`、
    `shared/api.interface.ts`、`openapi/ewoh.yaml` + `route-manifest.json`。
  - `src/edge_platform/server.py` + 新模块 + `src/edge_platform/tests/`。
  - `ewoh-feishu-app/server/*` + README（单实例契约）。
  - `.github/workflows/runtime-gates.yml / standalone.yml / perf.yml / test.yml`、`scripts/*`、`docs/decisions/*`、
    `CHANGELOG.md`、`README.md`。
- **BREAKING**：无预期破坏性 API/DB/状态机变化；新增能力以“新增 + 兼容”方式提供；scheduler.service 拆分为
  内部行为不变的重构；新增 migration 均为向后兼容增量。

## ADDED Requirements

### Requirement: Scheduler 大规模性能（staged candidate generation + 永久 benchmark）
系统 SHALL 将候选生成改为 staged pipeline（skills prefilter → availability index → capability/status
index → spatial/station prefilter → reservation conflict prefilter → Top-K bounding → expensive
route/scoring → deterministic ranking），并为 RouteCost/TravelCost 提供本 run 确定性 memoization；
SHALL 提供增量 replan fast-path（unchanged task / unaffected subgraph 不重做全量候选枚举）；
SHALL 将 explanation trace 保存为 compact rejection code（UI 需要时再 materialize）；
SHALL 提供永久 benchmark（10/100/500/1000，含 wall time / peak heap / candidate count / assignment
rate / solverStatus），目标 500 tasks < 5s、1000 tasks < 10s 且不允许 OOM；无法达标时如实给出新基线并接入 CI。

#### Scenario: 大规模求解不退化语义
- **WHEN** 对同一 snapshot/policy 在优化前后各求解一次
- **THEN** assignment parity、hard constraint invariant、station capacity、skills ALL/ANY、device
  capabilities、locked/excluded/preferred、reservation safety、safety critical、deterministic replay 全部一致

#### Scenario: benchmark 基线可复现
- **WHEN** 在相同 seed/机器上重跑 benchmark
- **THEN** 输出 wall time / peak heap / candidate count / assignment rate / solverStatus，并与 CI 回归比较

### Requirement: Scheduler 模块化（Strangler Refactor）
系统 SHALL 在 characterization tests 保护下将 `scheduler.service.ts` 拆为职责单一的可独立测试服务，
原文件保留为 facade/compatibility；SHALL 将 heuristic solver 拆为 CandidateEnumerator /
FeasibilityEvaluator / AssignmentScorer / StationAllocator / ResourceAllocator / TraceCollector /
SolutionAssembler；不改变行为快照。

#### Scenario: 重构后行为一致
- **WHEN** 对重构前后相同输入执行计划生成/审批/拒绝/派发/replan
- **THEN** 输出与行为快照一致，全部既有 scheduler spec 通过

### Requirement: Scheduler 多租户/RLS 边界（ADR + 数据库级证据 + E2E）
系统 SHALL 对 ewoh_outbox / ewoh_world_state_snapshot / ewoh_assignment_event / ewoh_replan_trigger /
ewoh_scheduling_run / ewoh_scheduling_plan_assignment / ewoh_scheduling_constraint /
ewoh_scheduling_feedback / ewoh_scheduling_policy 逐一形成 GLOBAL_SHARED / TENANT_SCOPED /
DERIVED_TENANT_OWNERSHIP 分类 ADR；TENANT_SCOPED 必须同时具备 DB RLS 与应用层过滤双保险；
child table 必须通过 plan/run ownership 形成可验证的 tenant boundary（数据库级约束或安全策略）；
SHALL 提供真实 PostgreSQL multi-tenant E2E：Org A 创建 run/policy/feedback/replan/constraint/plan，
Org B 不能 list/get/update/delete/approve/dispatch；并覆盖 service_role 预期行为。

#### Scenario: 跨租户不可访问
- **WHEN** Org B 对 Org A 的数据执行任何读/写/审批/派发操作
- **THEN** 返回空/拒绝，且无数据泄漏（RLS + 应用层双重验证）

### Requirement: CommandMap Store 与唯一状态源
系统 SHALL 提供 useCommandMapController + CommandMapStore（selection/viewport/mode/replay/
scheduler-realtime/decision-context），selectedTaskId / selectedPlanId / selectedEntityId 有唯一状态源，
禁止 `plans[0]` 等隐式 fallback；SSE 事件更新 SHALL 通过 selector/memoization 局部更新，
大型 entity/task 使用 viewport culling / layer memoization / list virtualization / progressive rendering。

#### Scenario: SSE 不引起全量 rerender
- **WHEN** 收到单条 outbox/SSE 事件
- **THEN** 仅相关 layer/store slice 更新，selection 不被重置

### Requirement: Decision Cockpit 统一决策上下文
系统 SHALL 保留 ConflictCenter / TaskIntelligence / RejectedCandidateExplain / ReplanPreview /
PlanCompare / Override 既有能力，并新增统一 Decision Context（WHAT HAPPENED / WHY / IMPACT /
SYSTEM DECISION / WHY THIS ASSIGNMENT / WHY NOT OTHERS / COST / RECOMMENDED ACTION / ACTIONS），
复用 ReplanImpact / PlanAssignmentDiff / DecisionTrace / CandidateExplain / Conflict /
SchedulingFeedback，前端不重推业务规则；SHALL 提供 "Why did this task move?" 因果链（含 cause chain 与
unchanged-task 展示）；SHALL 提供全局 Data Freshness Model（LIVE/DELAYED/STALE/OFFLINE/REPLAY/SHADOW
+ lastUpdatedAt/source/lag/reason）；SSE 断开但缓存存在时不得呈现为 live；CP-SAT fallback heuristic 时
方案详情显式显示 Solver 状态链（CP-SAT requested → UNAVAILABLE → Heuristic fallback）。

#### Scenario: 任务移动可解释
- **WHEN** replan 将任务 T381 从 John/EXO-17/S4 移至 Li/EXO-12/S4
- **THEN** Decision Context 展示 cause chain（如 DEVICE_OFFLINE → T381 affected → ... → selected）与
  unchanged tasks，让用户确认无无意义重排

### Requirement: CP-SAT Activation（OFF → SHADOW → CANARY → PRODUCTION）
系统 SHALL 在既有 worker/adapter/fallback 基础上落实 worker 运行级能力（health/readiness、timeout、
max problem size、memory limit、concurrency limit、graceful shutdown、structured metrics、
request correlation ID）；SHADOW 模式 SHALL 对同一 snapshot/policy 双跑 heuristic + CP-SAT 并输出对比
指标（feasibility/objective/priority compliance/hard violations/station allocation/churn/runtime/
timeout/fallback），shadow 结果不得 dispatch/approve/reserve；CANARY SHALL 支持按 org/site 确定性采样、
canary fraction、error budget、timeout budget、fallback threshold、invariant violation auto rollback、
manual rollback；任何 hard constraint divergence 必须立即自动回退 heuristic；runtime gate 与
shadow/canary 指标达标前 productionEnabled 恒为 false。

#### Scenario: CP-SAT 不可用如实降级
- **WHEN** CP-SAT worker 不可达/超时/超规模
- **THEN** 产生 UNAVAILABLE/TIMEOUT/FALLBACK 状态并回退 heuristic，不冒充 CP-SAT 成功，UI 显式展示状态链

### Requirement: Prediction Shadow Learning 持久化
系统 SHALL 提供 durable observation 表（prediction_shadow_observation）持久化预测样本与 actual 回填，
backfill 以 correlation id / taskId / executionId 优先，保留 (predictionType, createdAt) 为回退；
migration SHALL 具备 apply/verify/rollback/re-apply、indexes、retention；SHALL 支持 MAE/RMSE/p50/p95/
coverage/fallbackRate/calibration/modelVersion 对比/site-org 对比/rolling window 评价；重启后历史仍存在；
内存 ring buffer 仅作 fast cache；Prediction 保持 advisory-only，不改变正式调度结果。

#### Scenario: 重启后评价历史保留
- **WHEN** 服务重启后查询 shadow 评价
- **THEN** 历史 observation 与聚合指标仍可从持久化存储读出

### Requirement: Runtime Gates 自动闭环（尽力而为 + BLOCKED 如实）
系统 SHALL 在 GitHub Actions 尝试 ephemeral kind/k3d 集群真实执行 Helm install/health/smoke/upgrade/
failed-upgrade/rollback/post-rollback、canary 注入失败回滚、soak/load（scheduler event storm / SSE
reconnect / outbox / PG pool / memory growth / prediction samples / feishu queue / edge
backlog-replay），所有项必须设置硬上限与超时；环境无法执行项 SHALL 标记 BLOCKED 并保留一键脚本与证据路径。

#### Scenario: 无集群环境如实标记
- **WHEN** 本地/CI 无法创建真实集群
- **THEN** 输出 BLOCKED_BY_ENVIRONMENT 与可复现命令，不伪造 PASS

### Requirement: Edge server 模块化与契约保持
系统 SHALL 按 route domain 从 `src/edge_platform/server.py` 提取模块，分离 routing/serialization/
auth-middleware/service-invocation/lifecycle，保持 HTTP/SSE 契约完全兼容，零/极少运行时依赖
（不引入大型 Web Framework），并补充 characterization tests。

#### Scenario: 契约兼容
- **WHEN** 重构后按既有 route 发起请求
- **THEN** 状态码/响应体/SSE 事件流与重构前一致（characterization tests 覆盖）

### Requirement: Repository Truth Gate（feature-status.yaml）
系统 SHALL 提供统一 feature-status.yaml（每项含 implemented/tested/deployable/productionEnabled/
runtimeVerified/docsUpdated/evidence），CI SHALL 自动校验：resolved 的 OPEN decision 不得仍显示 open；
docs 声称 production-ready 必须存在 runtime evidence；OpenAPI route manifest 与 controller 零漂移；
version.json/README/release tag 语义一致；generated TS contracts 可重新生成且 git diff 为 0。

#### Scenario: 文档与代码漂移被阻断
- **WHEN** 某 feature 的 docs 声明与 manifest/代码证据不一致
- **THEN** CI 校验失败并输出具体差异

## MODIFIED Requirements

### Requirement: 性能基准（扩展现有 benchmark-scheduler.ts）
继承 [benchmark-scheduler.ts](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/scripts/benchmark-scheduler.ts)
的确定性合成负载与 seed 语义，新增任务规模档位 10/100/500/1000、peak heap 与 candidate count 输出、
before/after 对比记录，并接入 CI 回归（超时/超内存即失败）。

### Requirement: RLS 主体（扩展现有 standalone_025）
继承 [standalone_025_scheduler_rls.sql](file:///Volumes/Extra/CodeProj/EWOH/db/migrations/standalone_025_scheduler_rls.sql)
已启用的 8 表 RLS 与 `app.current_org_id` GUC 语义，将非 RLS 表（outbox / world_state_snapshot /
assignment_event）的设计原因升级为正式 ADR，并补齐 child table 数据库级验证与多租户 E2E。

### Requirement: CP-SAT fallback（扩展现有 cp-sat-scheduling-solver + solver.service）
继承既有 fallback/契约测试，不重写第二套 solver；在此基础上落实 worker 运行级能力与 SHADOW/CANARY
指标与回滚语义。

## REMOVED Requirements

无（延续既有能力，不删除既有功能；仅移除被重构吸收的内联实现）。
