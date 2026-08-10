# 生产级收敛与用户体验深化（Converge Prod UX）Spec

> change-id：`converge-prod-ux`
> 日期：2026-08-10 ｜ 依据：用户最新一轮“生产级收敛与用户体验深化”需求（§一~§十九）+ 对当前 main（HEAD=109b4b0）**逐项运行时代码核验**（不使用 README/旧 PRD/注释作为事实源）
> 前置 spec（已完成并推送 main）：`cmd-map-intelligent-scheduling`（f55ca68）、`deepen-scale-cockpit-closure`（109b4b0）、`scheduler-phase1-availability-profiles`（78285ab）、`scheduler-phase0-truth-context`（4bbbbb8）

## Why

用户要求把项目从“功能基本完整”提升到“可证明、可规模化、可长期维护的 production-ready”。经对 HEAD=109b4b0 的运行时代码、migration、契约、部署配置、测试交叉核验，**大量历史项已在最近交付中落地**（性能 500 tasks≈1.64s / 1000≈8.5s 且无 OOM、CommandMap store/图层/虚拟化、Data Freshness 六态、CP-SAT 超时/UNAVAILABLE 显式回退、Edge/Feishu 加固、真实 PG CI、truth gate 等）。

本轮**不重复实现已满足项**，只收敛经代码确认仍存在的真实缺口。逐项核验证据见下“核验结论”。

## 核验结论（HEAD=109b4b0，运行时代码证据）

| 用户章节 | 现状（代码证据） | 结论 |
|---|---|---|
| §一 Solver 激活状态 | 无运行时激活状态：`OFF→SHADOW→CANARY→PRODUCTION` 仅注释锚点（cp-sat-scheduling-solver.ts:39-40）；`SolverService.solve()` 恒先调 `cpSatSolver.solve()`（solver.service.ts:199），worker 可达且 OPTIMAL/FEASIBLE 即作为生产方案（cp-sat-scheduling-solver.ts:244-262）；`parseConfig` **丢弃 `cpSat` 字段**（scheduling-policy.service.ts:428-535），SHADOW 无法经配置开启；canary 采样/回滚管线**无运行时调用方**（shadow-evaluator.service.ts 仅定义）；solverStatus/fallbackReason **不落库**（ewoh_schedule_plan 无列）；README 声明 heuristic canonical 与代码“CP-SAT-first”矛盾；approve/dispatch 的 shadow guard 已接线（plan.service.ts:211-213,381-383），reserve guard 无调用方（无 reserve 路由，reserve 发生在 dispatch 内，已被 dispatch guard 覆盖） | ⚠️ 真实缺口 |
| §二 OpenAPI 闭环 | `npm run gen:openapi` 已跑通、`.d.ts` 零漂移（本 spec 实证）；全部 scheduler $ref 可解析；但 `route-manifest.json` **不可复现/过期**（GET key 重复、`GET /api/scheduler/context` 仍标 undocumented、generatedAt 早于 HEAD）；controller 已有 `/api/scheduler/context` 但 ewoh.yaml 未文档化；`audit-openapi-routes --strict` 与 `gen:openapi:check` 仅接在 standalone.yml，test.yml 走非 strict（永不失败）；`shared/scheduler.ts` 与 generated types 手工重复且已漂移（SchedulerKpiSnapshot shared 侧多 6 字段）；无 jest 级路由双向一致性测试 | ⚠️ 真实缺口 |
| §三 Snapshot 版本并发 | `nextSnapshotVersion()` 仍 read-then-increment（world-state.service.ts:557-569），版本号在 insert 事务外计算（:46 vs :53-62）；`snapshot_version` 全局 UNIQUE 已存在（schema.ts:1224）；并发下第二个 insert 直接抛错且**无重试**；无并发 buildSnapshot 测试 | ⚠️ 真实缺口 |
| §四 affected 指标 | `affectedTaskCount()` 恒返回 `snapshot.tasks.length` 且丢弃 opts（solver.service.ts:368-375）；`scheduler_partial_replan_affected` 三条路径（replan/replan-preview/full run）全部按 snapshot size 上报；真实 affected set（`ReplanImpact.affectedTaskIds`）来自 impact-propagation，**与指标不同源**；KPI 用 `impact.affectedTaskIds.length`、gauge 用 snapshot size——定义不一致；缺 1/N/full 测试 | ⚠️ 真实缺口 |
| §五 性能 | staged candidate pipeline + run-local route-cost memo 已落地：500≈1.64s、1000≈8.5s、无 OOM；CI `scheduler-benchmark-gate` 矩阵 10/100/500/1000 已接线（perf.yml:98-162，硬上限 500≤20s/1000≤60s/无 OOM）；但 benchmark 输出缺 **CPU time、pruned count、route-cache hit ratio**（有 wallMs/peakHeapMb/candidateCount/assignmentRate/solverStatus/hardRejectCount） | ⚠️ 部分缺口 |
| §六 多实例 replan guard | `tryAcquireCrossInstanceGuard()` catch-all 后返回 `true` 并继续（replan-coordinator.service.ts:177-185），**prod/test 不区分、失败不 fail-closed**；无 advisory-lock 失败 metric；readiness 仅 `select 1`（health.controller.ts:27-37）；多实例测试为单进程模拟（replan-multi-instance.spec.ts），无双实例真实 PG 测试；debounce/min-interval/max-per-window/replan.suppressed 已满足 | ⚠️ 真实缺口 |
| §七 root DB 逃逸 | 业务侧仅 `DomainPersistenceService` 一个 root 消费者（domain-persistence.service.ts:104，无 GUC/RLS）；`DRIZZLE_DATABASE` proxy 在无 ALS 事务时静默落 root（request-database-context.ts:29）；token 由 `@Global` 模块导出，任何服务可注入；**无系统事务显式 API**；**无 root token allowlist 架构/lint 测试**；cross-org RLS 为顺序应用层测试，**无并发跨 org、无运行时 GUC 行过滤断言** | ⚠️ 真实缺口 |
| §八 CommandMap 拆分 | 已拆分 store/hooks/layers/panels/vm，但 `CommandMap.tsx` 仍是 1304 行单一编排组件（228-1304）；未拆 Shell/Workspace/MapViewport | ⚠️ 部分缺口 |
| §九 URL-backed context | 仅 `event_id` 一次性读取（CommandMap.tsx:581-589）；mode/layer/selected*/activeTab/conflict/replayTimestamp/comparePlanIds **全部不落 URL**；无 task/plan/conflict/replay deep-link；无效 id 静默置 null，无用户可见说明 | ⚠️ 真实缺口 |
| §十 UX 认知成本 | Data Freshness 六态已落地（LIVE/DELAYED/STALE/OFFLINE/REPLAY/SHADOW，dataFreshness.ts:20），但 **RESYNCING/DEGRADED 不在 freshness 模型内**（属 SSE 连接态）；`SchedulerRealtimeBadge` 维护**第二套状态文案**（CommandMap.tsx:113-173）；dispatch/replan **无确认**（SchedulePanel.tsx:364-402）；override 仅事后 diff；conflict ack 用 `window.prompt`；`ReplanPreviewResult` UI 已写但**从未接线**（PlanComparePanel.tsx:124-152 无调用方）；preview 缺 solver 状态与 snapshot/policy version | ⚠️ 真实缺口 |
| §十一 大数据量 | 虚拟列表（2 面板）、viewport culling、memo、bundle budget 已落地；**无 SSE batching/coalescing**；**无 React profiler 基准** | ⚠️ 部分缺口 |
| §十二 无障碍 | labels/shortcuts/live region/help dialog focus 已有；**Command Map 无 axe 覆盖**；**无 table/list 替代视图**；SVG map `aria-hidden` 无 SR 文本替代；多数 overlay 无 focus 恢复；window.prompt 非 a11y | ⚠️ 部分缺口 |
| §十三 Edge runtime | bus bounded/backoff/backfill 幂等/stale→DQ 已满足；但 `EWOH_EDGE_SCHEDULING_WRITE=1` **不区分 mode**（run.py:87，production 下也可写）；**无 adapter supervisor/respawn**；故障注入缺 sensor disconnect、adapter crash | ⚠️ 部分缺口 |
| §十四 Feishu 侧车 | lark-cli timeout/retry/circuit-breaker/structured error、webhook 签名/幂等/fail-closed auth、SQLite 单实例语义文档均满足；**无 /health/live 与 /health/ready 区分本地 vs Feishu 集成**；轮询仍为主、webhook 仅卡片按钮；**CI 无 feishu-app 测试 job** | ⚠️ 部分缺口 |
| §十五 真实 PG E2E | CI 已接 PG17 全链（fresh migration/schema verify/seed/boot/scheduler upgrade E2E/RLS 多租户 E2E/reservation concurrency/override stale-version/outbox-SSE resume/teardown）；**缺 snapshot 并发 E2E、双实例 replan E2E、previous-RC→main 升级测试**（现仅相邻 004→005）；release gate 无“PG 缺失即整包失败”的强制 | ⚠️ 部分缺口 |
| §十六 故障注入 | 已满足：CP-SAT unavailable/timeout、SSE Last-Event-ID+gap→resync、dup webhook/ingest/dispatch、stale approval、rolling restart、Feishu 429/5xx；**缺**：CP-SAT malformed response（client）、PG 临时故障、Redis unavailable E2E、route graph_unavailable、sensor stale E2E | ⚠️ 部分缺口 |
| §十七 drift gate | truth-feature-status.js（feature/version/CP-SAT 部署漂移）、audit-openapi-routes、audit-repo-facts、audit-event-catalog 已接线；**缺**：env var inventory、solver activation mode 交叉核对、README capability 表行级核对；`truth-gate.js` 未直接 CI 接线 | ⚠️ 部分缺口 |

## What Changes（本轮范围 = 仅上述真实缺口）

**P0**
1. **P0-1 Solver 激活状态唯一事实源**：新增 `SolverActivationState = OFF | SHADOW | CANARY | PRODUCTION`；配置键 `SchedulingPolicyConfig.solver.activation`（parseConfig 补齐透传）+ env `EWOH_SOLVER_ACTIVATION`（缺省 OFF）；`SolverService.solve()` 按激活状态路由：OFF=仅 heuristic；SHADOW=heuristic 生产 + CP-SAT 双跑 isShadow（复用 solveShadowCompare 语义）；CANARY=按 org allowlist/百分比采样，CP-SAT 采样 org 生产化，硬约束分歧/超时/不可行→显式 fallback + 记录 + 回滚采样；PRODUCTION=仅当 feature-status `productionEnabled=true`（当前恒 false → fail-closed 拒绝）；plans/runs 落库 solverStatus/fallbackReason（增量 migration 加列，兼容存量）；shadow guard 三路（approve/reserve/dispatch）测试补齐；README/feature-status/deploy env 对齐；truth-feature-status.js 增加 activation 交叉核对；OFF/SHADOW/CANARY/PRODUCTION 集成测试。
2. **P0-2 OpenAPI 闭环**：文档化 `GET /api/scheduler/context`（ewoh.yaml + 共享类型对齐 SchedulerKpiSnapshot 等已漂移定义）；重生成 `route-manifest.json`（消除 GET key 重复，使 manifest 可复现）；`audit-openapi-routes --strict` 与 `gen:openapi:check` 接入 test.yml；新增 jest 级 documented↔implemented 双向一致性测试；新增 shared↔generated type parity 测试（先修复已漂移的 SchedulerKpiSnapshot/ConflictPreviewRequest 等）。
3. **P0-3 Snapshot 版本原子分配**：增量 migration 新增 counter 表（`ewoh_snapshot_version_counter`，day 行 + `SELECT ... FOR UPDATE`）+ 保留 `WS-YYYYMMDD-NNNN` 语义 + 既有 `snapshot_version` UNIQUE 约束兜底 + **bounded retry**（≤N 次）；高并发 buildSnapshot 集成测试。
4. **P0-4 affected 指标统一**：`SolveOptions` 增加 `affectedTaskIds`；`affectedTaskCount()` 消费真实 affected（partial=impact 集、full=快照任务数）；`scheduler_partial_replan_affected` 与 KPI/log/preview 同源；1/N/full 单元+集成测试。

**P1**
5. **P1-5 benchmark 字段补全**：矩阵输出增加 cpuTimeMs、prunedCount、routeCacheHitRatio，保持现有 CI gate 与目标阈值（500<5s / 1000<10s / 无 OOM 作为报告断言，CI 保留宽松安全界）。
6. **P1-6 Replan guard fail-closed**：新增部署模式配置（`EWOH_DEPLOY_TARGET=production` 或等价）；advisory-lock 能力异常时 production **fail-closed**（阻止 automatic replan + 显式 degraded）+ metric `scheduler_replan_guard_degraded_total` + health/readiness 返回 degraded reason；test/development 显式允许 memory fallback；新增**双实例真实 PG** replan 幂等集成测试。
7. **P1-7 root DB 逃逸收敛**：`RequestDatabaseContext` 新增显式 `systemTransaction()` API；`DomainPersistenceService` 改走显式事务 API；新增架构/lint 测试禁止非 allowlist 模块引用 `STANDALONE_ROOT_DATABASE`；新增并发跨 org RLS + 运行时 GUC 行过滤断言集成测试。
8. **P1-8 CommandMap 拆分**：`CommandMap.tsx`（1304 行）拆为 `CommandMapShell` + `SchedulerWorkspace`/`ReplayWorkspace`/`ConflictWorkspace`/`PlanCompareWorkspace`/`DecisionCockpitWorkspace`/`IntelligenceWorkspace` + `MapViewport`；状态继续收敛在 zustand store，不散回组件。
9. **P1-9 URL-backed operator context**：mode/layer/selectedEntityId/selectedTaskId/selectedPlanId/activeTab/conflict/event/replayTimestamp/comparePlanIds 同步到 URL query；刷新恢复、back/forward、可复制 URL 直达同一决策上下文、deep-link（task/event/plan）；非法/失效 id 自动降级并给出用户可见说明；不写入临时 UI 状态。
10. **P1-10 UX 深化**：Freshness 模型补齐 RESYNCING/DEGRADED 状态语义并统一全局（删除 SchedulerRealtimeBadge 第二套文案，统一走 DataFreshness 单一模型）；危险操作（approve/override/exclude/lock/replan/dispatch）统一“当前状态→预计影响→diff/preview→确认→执行结果”流；dispatch/replan 增加确认+preview；override 增加执行前 dry-run preview；conflict ack 替换 window.prompt 为 a11y dialog；接线 ReplanPreviewResult（affected/churn/lateness/travel/workload/conflicts/solver/snapshot-policy 展示）。
11. **P1-11 大数据量**：SSE batching/coalescing；React Profiler/performance benchmark（CI 接线）；长列表虚拟化覆盖补全（events/resources）。
12. **P1-12 无障碍**：Command Map axe 覆盖；resources/tasks/conflicts/assignments/events 的 table/list 键盘替代视图；SVG map 提供 SR 文本摘要；overlay focus 恢复（override 结果/conflict preview/diff drawer）；icon-only button accessible name 审计；状态非颜色通道 + 高对比。
13. **P1-13 Edge runtime**：production 模式代码级禁止 `EWOH_EDGE_SCHEDULING_WRITE=1`（fail-closed + 明确错误）；adapter supervisor（死线程探测+重启 + 指数退避）；故障注入测试：sensor disconnect、adapter crash（slow consumer/cloud offline 已有）。
14. **P1-15 真实 PG E2E 补全**：snapshot 并发 E2E、双实例 replan E2E（真实 PG）、previous-RC→current-main migration upgrade 测试（基于 release/ 快照 + 当前 migration 链）；release gate 强制“PG 不可用即失败，禁止整包 skip”。
15. **P1-16 故障注入补全**：CP-SAT malformed response（Nest client）、PG 临时故障、Redis unavailable E2E、route graph unavailable、sensor stale E2E。

**P2**
16. **P2-14 Feishu 侧车**：`/health/live` 与 `/health/ready`（本地 API vs Feishu 集成状态区分）；feishu-app 测试接入 CI。
17. **P2-17 drift gate 补全**：env var inventory 核对（deploy/.env.example ↔ 代码 env 读取）；solver activation mode 交叉核对（truth-feature-status.js）；README capability 表行级核对；truth-gate.js CI 接线。

**§十八 质量约束**：全程遵守（禁止无目的重写、无关模块改动、删 explainability/audit 字段、前端重算后端事实、`catch {}` 静默吞异常、新 magic constant、any/unknown 绕过、为测试放松安全校验、伪装失败为成功、CP-SAT fallback 冒充 CP-SAT 成功、改动冻结 delivery/ 与历史 ui/command_map/）。

## Impact

- 受影响代码：
  - `ewoh-spark-app/shared/scheduler.ts`（SolverActivationState、SchedulingPolicyConfig.solver、SolveOptions.affectedTaskIds、KPI/Preview 类型对齐）
  - `ewoh-spark-app/server/modules/scheduler/`：`solver.service.ts`（激活状态路由 + affected 指标）、`scheduling-policy.service.ts`（parseConfig 透传）、`cp-sat-scheduling-solver.ts`（size budget/激活门）、`world-state.service.ts`（原子版本分配）、`replan-coordinator.service.ts`（fail-closed）、`scheduler.controller.ts`（context 文档化配合）、`scheduler.module.ts`、`shadow-policy.service.ts`（canary 接线）、`replan-preview.service.ts`、`kpi.service.ts`、`scheduler-metrics.service.ts`、`plan.service.ts`
  - `ewoh-spark-app/server/database/schema.ts` + 新增 `db/migrations/standalone_030_*`（plan/run solver 状态列、snapshot version counter）+ `db/verify/`
  - `ewoh-spark-app/server/database/request-database-context.ts`、`standalone-database.module.ts`、`server/modules/work-orchestration/domain-persistence.service.ts`
  - `ewoh-spark-app/server/modules/health/health.controller.ts`（advisory-lock degraded readiness）
  - `ewoh-spark-app/client/src/pages/CommandMap/`（拆分/URL 同步/UX/a11y/大数据）、`client/src/lib/dataFreshness.ts`、`client/src/lib/a11y.ts`、`client/src/types/openapi.d.ts`（重生成）
  - `openapi/ewoh.yaml`、`openapi/route-manifest.json`、`scripts/audit-openapi-routes.js`、`ewoh-spark-app/scripts/gen-openapi.js`
  - `scripts/truth-feature-status.js`、新增 env inventory/README capability drift 检查
  - `.github/workflows/test.yml`、`standalone.yml`、`runtime-gates.yml`、`perf.yml`（门禁接线）、`ewoh-feishu-app/server/index.js`（health）、`.github/workflows/`（feishu test job）
  - `src/edge_platform/run.py`、`src/edge_platform/edge/manager.py`（supervisor）
  - `ewoh-spark-app/scripts/benchmark-scheduler.ts`（cpuTime/pruned/routeCacheHitRatio）
- 受影响既有 spec：`deepen-scale-cockpit-closure`、`scheduler-phase1-availability-profiles`（已完成，本 spec 在其上增量）。
- 新增测试：solver-activation.spec、snapshot-version-concurrency.spec、affected-metrics.spec、route-parity/type-parity spec、replan-guard-failclosed.spec、root-db-allowlist.audit.spec、cross-org-concurrent.e2e、snapshot-concurrency.e2e、dual-instance-replan.e2e、edge-fault-injection、feishu-health.test、playwright command-map a11y/perf spec 等。

## ADDED Requirements

### Requirement: Solver 激活状态唯一事实源
系统 SHALL 提供唯一 `SolverActivationState`（OFF/SHADOW/CANARY/PRODUCTION），来源为 `SchedulingPolicyConfig.solver.activation`（env `EWOH_SOLVER_ACTIVATION` 可覆盖，缺省 OFF）；`SolverService.solve()` 必须按该状态路由，OFF=仅 heuristic 不调 CP-SAT；SHADOW=heuristic 生产 + CP-SAT 双跑且 isShadow；CANARY=按 org allowlist / canaryFraction 采样，硬约束分歧/不可行/超时/worker unavailable 时显式回退并记录；PRODUCTION=仅当 `feature-status productionEnabled=true` 才允许 CP-SAT canonical（当前恒 false，fail-closed）；每个 plan/run 记录 solverVersion/solverStatus/fallbackReason/policyVersion/snapshotVersion。

#### Scenario: OFF 模式不触发 CP-SAT
- **WHEN** activation=OFF 且 run 触发
- **THEN** 仅启发式求解，不发 CP-SAT 请求，plan.solverStatus 记录为启发式结果；无 shadow 产物

#### Scenario: CANARY 采样与回滚
- **WHEN** activation=CANARY 且 org 命中采样（百分比/allowlist）
- **THEN** 采样 org 的 plan 可由 CP-SAT 生成并标注；一旦出现硬约束分歧/不可行/超时/worker unavailable，回退启发式并把该 org 从采样集移除，记录 fallbackReason 且回滚行为可审计（canaryFraction→0 + outbox 事件）

#### Scenario: 生产禁写门禁
- **WHEN** activation=PRODUCTION 但 `productionEnabled=false`
- **THEN** 求解拒绝/回退 heuristic，明确错误，不将 CP-SAT 结果作为生产方案

### Requirement: OpenAPI 生成闭环
系统 SHALL 保证 `npm run gen:openapi` 生成 `openapi/ewoh.yaml`、`work-orchestration.yaml`、`route-manifest.json` 与 `client/src/types/*.d.ts` 与真实 controller 完全一致（生成后 `git diff` 为空）；所有 $ref 可解析；CI 中 documented↔implemented 双向一致性以 strict 模式执行（test.yml 与 standalone.yml 均不得以非 strict 静默通过）。

#### Scenario: 控制器与 spec 双向一致
- **WHEN** controller 新增/删除路由或 spec 新增/删除 path
- **THEN** `audit-openapi-routes --strict` 与 `gen:openapi:check` 失败（drift gate），禁止非 strict 通过

### Requirement: Snapshot 版本原子分配
系统 SHALL 通过数据库原子机制（counter 表 + `SELECT ... FOR UPDATE` + `snapshot_version` UNIQUE 兜底）分配 `WS-YYYYMMDD-NNNN`，两个及以上并发 `buildSnapshot()` 永不产生相同版本；分配失败重试必须 bounded（≤N 次），不得无限循环。

#### Scenario: 并发 buildSnapshot
- **WHEN** 两个并发请求对同日 buildSnapshot
- **THEN** 两个版本号不同且连续；失败场景下 bounded retry 后成功或明确失败，无重复版本落库

### Requirement: affected 指标同源
`scheduler_partial_replan_affected` SHALL 反映真实 affected tasks：partial replan 使用 impact propagation 的 `affectedTaskIds`；full replan 才等于整个 snapshot task count；KPI/stability/log/SSE 中“affected”概念使用同一事实源。

#### Scenario: partial vs full 指标
- **WHEN** partial replan 影响 3 个任务（快照 100）
- **THEN** `scheduler_partial_replan_affected=3`（非 100）
- **WHEN** full replan
- **THEN** 指标等于快照可调度任务数

### Requirement: Replan guard production fail-closed
production 部署下，PostgreSQL advisory-lock 能力异常时系统 SHALL fail-closed：阻止 automatic replan（或阻断请求并返回明确错误）、暴露 metric、health/readiness 返回 degraded reason；test/development 单实例可使用 memory fallback；同一 org 同一触发在多实例下不产生重复 replan。

#### Scenario: advisory-lock 不可用
- **WHEN** production 下 `pg_try_advisory_xact_lock` 抛错/不可用
- **THEN** automatic replan 被阻止（不静默降级为内存守卫），`scheduler_replan_guard_degraded_total` 递增，readiness 报告 degraded reason

### Requirement: root DB 访问受控
系统 SHALL 提供显式系统事务 API（`systemTransaction`）供 migrations/bootstrap/系统级操作使用；普通业务请求不得注入 root handle；新增架构/lint 测试禁止非 allowlist 模块引用 `STANDALONE_ROOT_DATABASE`；跨 org RLS 并发测试确保租户上下文不串。

#### Scenario: 非 allowlist 模块引用 root
- **WHEN** 普通业务模块 `@Inject(STANDALONE_ROOT_DATABASE)`
- **THEN** 架构/lint 测试失败；业务路径必须经 request transaction + org GUC + RLS

### Requirement: Command Map URL-backed operator context
mode/layer/selectedEntityId/selectedTaskId/selectedPlanId/activeTab/selected conflict/event/replayTimestamp/comparePlanIds SHALL 同步到 URL query/route；刷新恢复现场、back/forward 正常、URL 可分享直达同一决策上下文、deep-link（task/event/plan）可用；非法/失效 id 自动降级并给出用户可见说明；不写入无意义 UI 状态。

#### Scenario: 复制 URL 直达
- **WHEN** 调度员复制当前 URL 发给另一调度员
- **THEN** 对方打开后恢复同一 mode/图层/选中实体/计划/时间戳上下文
- **WHEN** URL 中的 id 已失效
- **THEN** 自动降级到默认上下文并明确提示“所选计划/任务已失效”

### Requirement: Data Freshness 全局统一模型
系统 SHALL 提供统一 freshness 模型（LIVE/DELAYED/STALE/OFFLINE/REPLAY/RESYNCING/DEGRADED），资源/计划/冲突/地图/SSE/轮询 fallback 使用同一状态文案，禁止各自定义。

#### Scenario: 状态文案单一来源
- **WHEN** SSE 进入 RESYNCING 或系统降级
- **THEN** 所有 UI 使用统一 freshness 词汇与配色（单一 DataFreshness 组件），无第二套并行文案

### Requirement: 危险操作 preview/diff/确认
approve/override/exclude/lock/replan/dispatch SHALL 提供“当前状态→预计影响→diff/preview→确认→执行结果”流；override/replan preview 展示 affected tasks/persons/devices/stations、lateness/travel/workload delta、conflicts 增减、solver/fallback 状态、snapshot/policy version；禁止操作员通过阅读 JSON 理解结果。

#### Scenario: replan 前预览
- **WHEN** 操作员点击 replan
- **THEN** 展示 affected/churn/lateness/travel/workload/conflict/solver/snapshot-policy 摘要与 diff 后再确认执行
- **WHEN** 操作员点击 dispatch
- **THEN** 必须先展示方案摘要与确认（不得直接执行）

### Requirement: 大数据量与性能可观测
大型 list/table 使用虚拟化；map layer 避免全量 rerender；SSE 高频事件 batching/coalescing；提供 React profiler/performance benchmark 与 CI 门禁；benchmark 输出 CPU 时间、wall time、peak memory、candidate count、pruned count、route-cache hit ratio、assignment rate。

### Requirement: 无障碍与非地图替代视图
resources/tasks/conflicts/assignments/events 提供键盘可操作的 table/list 替代视图；所有核心操作可键盘完成；dialog/drawer 开合后 focus 恢复；icon-only button 有 accessible name；状态不只依赖颜色；高对比可用；screen reader 可读出 task/resource status、conflict severity、最新更新时间。

### Requirement: Edge 生产写禁 + 监督
production 模式代码级禁止 `EWOH_EDGE_SCHEDULING_WRITE=1`（fail-closed + 明确错误）；adapter/pipeline 提供 health supervision 与死线程重启；reconnect/backoff 明确；EventBus/pipeline bounded；sensor stale/fault 进入 Data Quality；Edge→Cloud 幂等；网络恢复 backfill 不产生重复业务事件。

### Requirement: 真实 PG E2E 与故障注入
release gate 中真实 PostgreSQL（17）E2E 不得因 PG 缺失整包 skip（缺则明确失败）；覆盖 fresh migration/schema verify/seed/boot/scheduler upgrade/RLS 多租户/reservation concurrency/snapshot concurrency/override stale-version/replan 多实例/outbox-SSE resume/teardown 与 previous-RC→current-main 升级；故障注入至少覆盖 CP-SAT unavailable/timeout/malformed、PG 临时故障、Redis unavailable、SSE 断连+Last-Event-ID、SSE gap→resync、重复 webhook/ingest/dispatch、stale approval、rolling restart、Feishu 429/5xx、route graph 不完整、sensor stale；所有降级在 UI 与 metrics 可观察，禁止 silent fallback。

### Requirement: Feishu 侧车可观测性
`/health/live` 与 `/health/ready` SHALL 区分本地 API healthy 与 Feishu 集成 unavailable；lark-cli child process 有 timeout/bounded retry/circuit breaker/structured error；webhook/event-driven 优先、轮询 fallback；SQLite 模式明确 single-instance；保持 webhook signature、业务幂等、fail-closed auth；feishu-app 测试接入 CI。

## MODIFIED Requirements

### Requirement: Solver 生产回退可观测（原 CP-SAT first + 显式 fallback）
保持超时/UNAVAILABLE 显式回退（solverStatus/fallbackReason 内存态）不变，升级为：激活状态控制 CP-SAT 是否被调用；solverStatus/fallbackReason **持久化到 plan/run 表**（增量列）。

### Requirement: 性能门禁（原矩阵 10/100/500/1000 + 宽松安全界）
保持 CI 宽松安全界（500≤20s / 1000≤60s / 无 OOM）防 CI 机器波动误伤；benchmark 报告断言目标阈值（500<5s / 1000<10s / 无 OOM）并补充 CPU time / pruned count / route-cache hit ratio。

### Requirement: Replan 风暴治理（原 advisory lock + 内存回退）
内存回退仅限 test/development；production 下 advisory-lock 能力异常 fail-closed + metric + degraded readiness；debounce/min-interval/max-per-window/replan.suppressed 行为不变。

### Requirement: 租户隔离（原应用层 org 过滤 + RLS）
root handle 使用收敛到显式系统事务 API；业务路径必须经 request transaction + org GUC + RLS；新增运行时 GUC 行过滤断言与并发跨 org 测试。

## REMOVED Requirements
无（本轮全部为增量/修复）。

## 明确不做（ROADMAP，仅记录）
- 重写 CP-SAT Python worker 求解算法：维持现有 worker，仅补 size budget 与 client 侧 malformed-response 防护。
- Feishu 多实例共享 cursor/Redis 迁移：当前明确 single-instance 语义，多实例方案保持文档化（不新增基础设施）。
- availability 交集 / tool/material/vehicle 真实模型：条件性需求，维持现有占位。
- 将 release/ 冻结交付或历史 `ui/command_map/` 作为生产源码修改：禁止。
