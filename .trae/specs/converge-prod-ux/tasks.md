# Tasks

> 原则：先补测试 → 改代码 → 回归 → 提交 main。所有改动保持现有系统可运行 + 渐进式升级。
> 事实源：运行时 + migration + 契约 + 部署 + 测试交叉核验（不信任 README/旧报告/注释）。
> 完成每个 Task 后立即 push 到 origin/main（用户既定约定），不做旁支等待合并。

## P0 任务（真实缺口，最高优先）

- [x] Task 1: Solver 激活状态唯一事实源（§一 P0）
  - [x] 1.1 `shared/scheduler.ts` 新增 `SolverActivationState = 'OFF'|'SHADOW'|'CANARY'|'PRODUCTION'` 与 `SchedulingPolicyConfig.solver { activation, canaryFraction?, orgAllowlist? }`（含默认 OFF）
  - [x] 1.2 `scheduling-policy.service.ts` parseConfig 补齐 `solver` 块透传（修复当前丢弃 `cpSat` 导致 SHADOW 不可达的问题），支持 env `EWOH_SOLVER_ACTIVATION` 覆盖
  - [x] 1.3 `SolverService.solve()` 按激活状态路由：OFF=仅 heuristic 不调 CP-SAT；SHADOW=heuristic 生产 + CP-SAT 双跑 isShadow（复用/收敛 solveShadowCompare）；CANARY=org allowlist + canaryFraction 采样、分歧/不可行/超时/unavailable → 显式回退 + fallbackReason + canaryFraction→0 + outbox `policy.shadow.canary.rollback`；PRODUCTION=仅当 `productionEnabled=true`（当前恒 false → fail-closed 拒绝，不得将 CP-SAT 当生产方案）
  - [x] 1.4 增量 migration `standalone_030_solver_activation`：`ewoh_schedule_plan` 与 `ewoh_scheduling_run` 增加 `solver_status` / `fallback_reason` 列（可空、兼容存量），persistPlan/createRun 写入；verify SQL
  - [x] 1.5 shadow guard 三路补齐测试（approve/reserve/dispatch；reserve 无独立路由，在 dispatch 内验证 guard 生效）
  - [x] 1.6 `scripts/truth-feature-status.js` 增加 solver activation 交叉核对（feature-status.yaml `cpSat.productionEnabled` ↔ 代码 activation=PRODUCTION 能力；README/feature-status/deploy env 三方一致）
  - [x] 1.7 集成测试：OFF（不发 CP-SAT 请求）/ SHADOW（双跑 + isShadow 且不可审批派工）/ CANARY（采样 org 生效、分歧回滚）/ PRODUCTION（productionEnabled=false 时 fail-closed）
  - [x] 1.8 对齐 README/feature-status.yaml/deploy env：solver activation 说明与 `EWOH_SOLVER_ACTIVATION` 变量入库 deploy/.env.example
- [x] Task 2: OpenAPI 生成闭环（§二 P0）
  - [x] 2.1 文档化 `GET /api/scheduler/context`（scheduler.controller.ts 已有实现 → ewoh.yaml 补 path + schema）
  - [x] 2.2 修复 shared↔spec 已漂移类型（SchedulerKpiSnapshot 补 6 个 replan 字段、ConflictPreviewRequest 对齐；`shared/scheduler.ts` 与 ewoh.yaml/openapi.d.ts 三方一致）
  - [x] 2.3 修正 `route-manifest.json` 生成（消除 GET key 重复、`GET /api/scheduler/context` 进入 documented；重生成后 git diff 为空且可复现）
  - [x] 2.4 test.yml 增加 `npm run gen:openapi:check` + `node scripts/audit-openapi-routes.js --strict`（当前仅 standalone.yml strict；test.yml 非 strict 永不失败）
  - [x] 2.5 新增 jest 级 documented↔implemented 双向一致性测试（消费 route-manifest + controller decorator 元数据）
  - [x] 2.6 新增 shared↔generated type parity 测试（P4 scheduler 契约：ExecutionUpdateRequest/ExecutionListResponse/SchedulerKpiSnapshot/PolicyReplayRequest/ConflictPreviewRequest/ReplanPreviewRequest/Result），减少手工重复定义漂移
- [x] Task 3: WorldStateSnapshot 版本原子分配（§三 P0）
  - [x] 3.1 增量 migration `standalone_031_snapshot_version_counter`：counter 表（day 主键 + last_seq）+ verify；保留既有 `snapshot_version` UNIQUE
  - [x] 3.2 `world-state.service.ts` nextSnapshotVersion 改原子分配（counter 行 `SELECT ... FOR UPDATE` 或 advisory lock + unique 兜底），保留 `WS-YYYYMMDD-NNNN` 语义；buildSnapshot 失败 bounded retry（≤3 次，每次重新分配），超限明确失败
  - [x] 3.3 高并发 buildSnapshot 集成测试（真实 PG：N 个并发调用，断言版本互异 + 单调递增 + 无重复落库）
- [x] Task 4: affected-task 指标统一（§四 P0）
  - [x] 4.1 `SolveOptions` 增加 `affectedTaskIds?: string[]`；partial replan/replan-preview 调用点传入 impact.affectedTaskIds；full run 不传
  - [x] 4.2 `SolverService.affectedTaskCount()` 改为消费 affectedTaskIds（partial=集大小、full=snapshot 可调度任务数）；`scheduler_partial_replan_affected` 与 KPI/stability/log/preview 同源（统一到 impact.affectedTaskIds）
  - [x] 4.3 测试：1 个 affected、N 个 affected、full replan 三种情况的单元 + 集成（solver 路径 emission）

## P1 任务

- [x] Task 5: Scheduler benchmark 报告补全（§五 P1）
  - [x] 5.1 `scripts/benchmark-scheduler.ts` 矩阵输出增加 cpuTimeMs、prunedCount、routeCacheHitRatio（从 solver/candidate-engine/route-cost 记录；缺失处先补最小埋点）
  - [x] 5.2 报告增加目标阈值断言（500<5s / 1000<10s / 无 OOM）；保持 CI perf.yml 宽松安全界
- [x] Task 6: Replan guard production fail-closed（§六 P1）
  - [x] 6.1 新增部署模式配置（`EWOH_DEPLOY_TARGET` 或等价，缺省 development）；`tryAcquireCrossInstanceGuard` 在 production 下 advisory-lock 异常 → fail-closed（阻止 automatic replan + 明确错误），test/development 保留 memory fallback
  - [x] 6.2 metric `scheduler_replan_guard_degraded_total`（+record）与 health/readiness degraded reason（health.controller.ts 扩展，advisory-lock 能力探测）
  - [x] 6.3 双实例真实 PG replan 幂等 E2E（两个 app 实例同一 org 同一 trigger → 仅一个 replan，另一 suppressed；断言语义不变：debounce/min-interval/max-per-window/replan.suppressed）
- [x] Task 7: root DB 逃逸收敛（§七 P1）
  - [x] 7.1 `RequestDatabaseContext` 新增显式 `systemTransaction()` API（无租户 GUC 的命名系统事务，可审计）
  - [x] 7.2 `DomainPersistenceService` 改走显式事务 API；root token 仅限 migrations/bootstrap/system
  - [x] 7.3 架构/lint 测试：禁止非 allowlist 模块引用 `STANDALONE_ROOT_DATABASE`（jest AST audit 或 eslint rule）
  - [x] 7.4 新增运行时 GUC 行过滤断言测试 + 并发跨 org RLS 集成测试（真实 PG，并发请求租户不串）
- [x] Task 8: CommandMap 拆分（§八 P1，禁止破坏功能）
  - [x] 8.1 拆分 `CommandMap.tsx`（1304 行）→ `CommandMapShell` + `SchedulerWorkspace`/`ReplayWorkspace`/`ConflictWorkspace`/`PlanCompareWorkspace`/`DecisionCockpitWorkspace`/`IntelligenceWorkspace` + `MapViewport`
  - [x] 8.2 状态继续收敛 zustand store（不散回组件）；行为快照/回归测试确保零功能回归
- [x] Task 9: URL-backed operator context（§九 P1）
  - [x] 9.1 URL query 同步：mode/layer/selectedEntityId/selectedTaskId/selectedPlanId/activeTab/conflict/event/replayTimestamp/comparePlanIds（写入 + 读取；back/forward 正常；刷新恢复）
  - [x] 9.2 deep-link：task/event/plan 直达（扩展现有 event_id 逻辑）
  - [x] 9.3 非法/失效 id 自动降级 + 用户可见说明；不写入临时 UI 状态（dialog animation 等）
- [x] Task 10: UX 认知成本深化（§十 P1，不改变业务事实）
  - [x] 10.1 freshness 模型补齐 RESYNCING/DEGRADED 语义并全局统一（删除 SchedulerRealtimeBadge 第二套文案 → 单一 DataFreshness 组件）
  - [x] 10.2 dispatch/replan 增加确认 + preview；override 增加执行前 dry-run preview；conflict ack 替换 window.prompt 为 a11y dialog
  - [x] 10.3 接线 ReplanPreviewResult（PlanComparePanel 已写未接线）→ replan 前展示 affected/churn/lateness/travel/workload/conflicts/solver 状态/snapshot-policy version
  - [x] 10.4 approve/override/exclude/lock 统一“当前状态→影响→确认→结果”流（保留现有 stale-version 与审计行为）
- [x] Task 11: 大数据量体验（§十一 P1）
  - [x] 11.1 SSE batching/coalescing（schedulerRealtimeCore）
  - [x] 11.2 React Profiler/performance benchmark 脚本 + CI 接线；虚拟化覆盖补全（events/resources 长列表）
- [x] Task 12: 无障碍与非地图替代视图（§十二 P1）
  - [x] 12.1 Command Map axe 覆盖（Playwright a11y spec）
  - [x] 12.2 resources/tasks/conflicts/assignments/events table/list 键盘替代视图；SVG map SR 文本摘要
  - [x] 12.3 overlay focus 恢复（override 结果/conflict preview/diff drawer）；icon-only button accessible name 审计；状态非颜色通道 + 高对比
- [x] Task 13: Edge runtime 可靠性（§十三 P1）
  - [x] 13.1 `run.py` production 模式代码级禁止 `EWOH_EDGE_SCHEDULING_WRITE=1`（fail-closed + 明确错误，仅 development/test 允许）
  - [x] 13.2 adapter supervisor：死线程探测 + 重启 + 指数退避（edge/manager.py）
  - [x] 13.3 故障注入测试：sensor disconnect、adapter crash（slow consumer/cloud offline 已有）
- [x] Task 14: 真实 PG E2E 与迁移升级测试（§十五 P1）
  - [x] 14.1 snapshot 并发 E2E（真实 PG）
  - [x] 14.2 双实例 replan E2E（真实 PG；与 Task 6 协同）
  - [x] 14.3 previous-RC→current-main migration upgrade 测试（基于 release/ 快照建库 + 当前 migration 链；CI 接线）
  - [x] 14.4 release gate 强制“PG 不可用即失败”，禁止整包 skip（校验 workflow 中 skip 分支）
- [x] Task 15: 故障注入补全（§十六 P1）
  - [x] 15.1 CP-SAT malformed response（Nest client 侧）
  - [x] 15.2 PG 临时故障测试；Redis unavailable E2E；route graph unavailable；sensor stale E2E
  - [x] 15.3 所有降级在 UI + metrics 可观察断言（禁止 silent fallback）

## P2 任务

- [x] Task 16: Feishu 侧车可靠性补全（§十四 P2）
  - [x] 16.1 `/health/live` + `/health/ready`（区分本地 API healthy vs Feishu 集成 unavailable）
  - [x] 16.2 feishu-app 测试接入 CI（当前无 job）
- [x] Task 17: 事实源 drift gate 补全（§十七 P2）
  - [x] 17.1 env var inventory 核对（deploy/.env.example ↔ 代码 env 读取）
  - [x] 17.2 solver activation mode 交叉核对（并入 Task 1.6 或独立）
  - [x] 17.3 README capability 表行级核对 + truth-gate.js CI 接线
- [x] Task 18: 最终验证与交付报告（§十九）
  - [x] 18.1 全量门禁：Python pytest、Python lint/security、server jest、client jest、tsc node、tsc app、ESLint、Stylelint、OpenAPI 生成、route manifest audit、repository facts、migration plan、fresh PG migration、previous-version upgrade、standalone real PG E2E、Command Map Playwright、accessibility、scheduler benchmark 10/100/500/1000、security gate、runtime gate
  - [x] 18.2 交付报告按用户结构输出：A 修复前事实核验 / B P0 / C P1 / D P2 / E 架构变化 / F UX 变化 / G migration / H API-contract 变化 / I 新增测试 / J benchmark 前后对比 / K 内存峰值对比 / L 已知剩余问题 / M Production Ready 判定 / N 剩余 blocker；必须给出测试数量/失败/skip 及原因，不得只写 “tests pass”

# Task Dependencies
- Task 1 ← 无（最高优先，独立）；Task 2 与 Task 1 互不依赖，可并行
- Task 3、Task 4 独立于 Task 1/2，可并行（P0 组：1/2/3/4 并行）
- Task 6 依赖 Task 3 的 migration 基础设施（真实 PG 测试）但不阻塞其开始；Task 14.2 依赖 Task 6 实现
- Task 8 ← 无（基于当前 CommandMap）；Task 9/10/11/12 依赖 Task 8（同一文件区域）——先拆分再改
- Task 13 独立；Task 14.1 依赖 Task 3；Task 15 依赖 Task 1（CP-SAT client）
- Task 16 独立；Task 17 依赖 Task 1.6 与 Task 2（复用 drift 框架）
- Task 18 ← 全部
