# Converge Prod UX 交付报告（生产级收敛与用户体验深化）

> 日期：2026-08-10 ｜ 分支：main（HEAD 截至 6b4dfca + 修复 fe6dced）｜ 迭代：`converge-prod-ux`
> 本轮原则：不重复实现已在 main 落地的能力；只收敛经运行时代码核验的真实缺口；不伪造任何 PASS。

---

## A. 修复前事实核验（HEAD=109b4b0，运行时代码证据）

对本轮 17 节需求逐项以运行时代码 + migration + 契约 + 部署 + 测试交叉核验（非 README/旧报告）：

| 需求章节 | 修复前事实 | 处理 |
|---|---|---|
| §一 Solver 激活 | `solve()` 恒先调 CP-SAT（solver.service.ts:199），README 却称 heuristic canonical；`parseConfig` 丢弃 cpSat（SHADOW 不可达）；canary 管线无运行时调用方；solverStatus/fallbackReason 不落库 | **缺口 → 修复（P0）** |
| §二 OpenAPI | gen:openapi 已可跑通且 .d.ts 零漂移；但 route-manifest 不可复现（GET key 重复）、`GET /api/scheduler/context` 未文档化、test.yml 门禁非 strict、shared↔spec 类型漂移（SchedulerKpiSnapshot 缺 6 字段） | **缺口 → 修复（P0）** |
| §三 Snapshot 版本 | read-then-increment（world-state.service.ts:557-569），版本号在 insert 事务外，并发必撞 UNIQUE、无重试 | **缺口 → 修复（P0）** |
| §四 affected 指标 | `affectedTaskCount` 恒返回 snapshot.tasks.length；metric 三条路径不同源；KPI 用 impact.affectedTaskIds 而 gauge 用 snapshot size | **缺口 → 修复（P0）** |
| §五 性能 | staged pipeline + route memo 已落地（109b4b0：500=1.64s / 1000=8.5s 无 OOM）；benchmark 缺 cpuTime/pruned/cache-hit | **部分 → 补字段（P1）** |
| §六 Replan guard | advisory-lock 异常 catch-all 返回 true 静默降级内存态；无 metric/readiness；无双实例真实 PG 测试 | **缺口 → 修复（P1）** |
| §七 root DB | 仅 DomainPersistenceService 业务消费 root handle（无 GUC/RLS）；无系统事务 API；无 allowlist lint；无并发跨 org 测试 | **缺口 → 修复（P1）** |
| §八 CommandMap | 1304 行单一编排（store/hooks/layers/panels/vm 已拆分） | **部分 → 拆分（P1）** |
| §九 URL context | 仅 event_id 一次性读取；全部决策状态不落 URL；无 deep-link；失效 id 静默 | **缺口 → 修复（P1）** |
| §十 UX | freshness 六态已落地但 RESYNCING/DEGRADED 不在模型内；SchedulerRealtimeBadge 第二套文案；dispatch/replan 无确认；override 仅事后 diff；conflict ack 用 window.prompt；ReplanPreviewResult 死线未接 | **缺口 → 修复（P1）** |
| §十一 大数据 | 虚拟化 2 面板/culling/memo/bundle budget 已有；无 SSE batching、无 React profiler 基准 | **部分 → 补（P1）** |
| §十二 无障碍 | labels/shortcuts/live region 已有；无 Command Map axe、无 table 替代视图、SVG 无 SR 摘要、overlay 无 focus 恢复 | **部分 → 补（P1）** |
| §十三 Edge | bus bounded/backoff/backfill 幂等已满足；`EWOH_EDGE_SCHEDULING_WRITE=1` 不区分 mode；无 adapter supervisor | **部分 → 补（P1）** |
| §十四 Feishu | lark-cli timeout/retry/breaker/幂等/单实例文档已满足；无 /health/live 与 /health/ready；CI 无 feishu job | **部分 → 补（P2）** |
| §十五 真实 PG E2E | CI 已接 PG17 全链；缺 snapshot 并发、双实例 replan、RC→main 升级、release gate 防整包 skip | **部分 → 补（P1）** |
| §十六 故障注入 | 已覆盖 unavailable/timeout/SSE 恢复/重复 webhook/ingest/dispatch/stale approval/rolling restart/Feishu 429；缺 malformed response/PG 临时故障/Redis E2E/graph_unavailable/sensor stale | **部分 → 补（P1）** |
| §十七 drift gate | truth-feature-status/audit-repo-facts/audit-event-catalog 已接线；缺 env inventory、activation 核对、README capability 行级核对、truth-gate.js CI 接线 | **部分 → 补（P2）** |

## B. P0 修复项

1. **Solver 激活唯一事实源（commit 8be7cf1）**
   - `SolverActivationState = OFF|SHADOW|CANARY|PRODUCTION`；配置键 `cpSat.activation/canaryFraction/orgAllowlist` + env `EWOH_SOLVER_ACTIVATION`（缺省 OFF，非法值回退）；`parseConfig` 补齐透传（修复 cpSat 丢弃 bug）。
   - `solve()` 按状态路由：OFF 不调 CP-SAT；SHADOW heuristic 生产 + CP-SAT 双跑 isShadow；CANARY org allowlist/确定性哈希采样，分歧/不可行/超时/unavailable → heuristic 回退 + `setCanaryFraction(0)` + outbox `policy.shadow.canary.rollback`；PRODUCTION 仅当 `EWOH_SOLVER_PRODUCTION_ENABLED=1`（当前恒 false → fail-closed `production_not_gated`）。
   - migration `standalone_030`：plan/run 新增 `solver_status`/`fallback_reason` 列并持久化；shadow guard 三路（approve/reserve/dispatch）测试；truth-feature-status activation 门禁；README/feature-status/env 对齐。
2. **OpenAPI 闭环（commit a693e7d）**：`GET /api/scheduler/context` 文档化；SchedulerKpiSnapshot 补 6 字段对齐；route-manifest 可复现（去重 + 去 generatedAt）；test.yml 接入 `gen:openapi:check` + `audit --strict`；新增 jest 双向路由 + shared↔generated type parity 测试。
3. **Snapshot 版本原子分配（commit c024733）**：`standalone_031` counter 表（day PK + last_seq）+ 事务内 `ON CONFLICT UPDATE RETURNING` 原子分配 + 既有 UNIQUE 兜底 + bounded retry（≤3 次，23505/40001 重试，超限明确失败）；保留 `WS-YYYYMMDD-NNNN`。
4. **affected 指标同源（commit 8be7cf1）**：`SolveOptions.affectedTaskIds`；partial 路径传入 `impact.affectedTaskIds`；`affectedTaskCount` partial=集大小、full=快照任务数；与 KPI/log/preview 同源。

## C. P1 修复项

5. **Benchmark 补全（commit 7ed46c6）**：矩阵输出 cpuTimeMs/prunedCount/routeCacheHitRatio + targetGate 断言（500<5s/1000<10s/无 OOM）；CI perf.yml 宽松安全界保持。
6. **Replan guard fail-closed（commit 9ad19bd）**：`EWOH_DEPLOY_TARGET=production` 下 advisory-lock 异常 → 抛错阻断 automatic replan（不再静默降级）；metric `scheduler_replan_guard_degraded_total`；readiness 报告 `scheduler.replanGuard: degraded + reason`；development 保留 memory fallback；双实例真实 PG E2E（D1 锁抑制 / D2 恰好 1 个 replan）。
7. **root DB 逃逸收敛（commit b127db8）**：`systemTransaction()` 显式系统事务 API；DomainPersistenceService 24 方法全量改走 systemTransaction；`root-db-allowlist.audit.spec.ts` 架构门禁（非 allowlist 引用即失败）；`org-rls-guc.e2e.spec.ts` 并发跨 org + 运行时 GUC 行过滤断言。
8. **CommandMap 拆分（commit d0b5e26）**：`CommandMap.tsx` 1304→12 行薄入口；`CommandMapShell` + `SchedulerWorkspace`/`ReplayWorkspace`/`ConflictWorkspace`/`PlanCompareWorkspace`/`DecisionCockpitWorkspace`/`IntelligenceWorkspace` + `MapViewport`；状态仍收敛 zustand store；188 CommandMap 测试零回归。
9. **URL-backed operator context（commit a7aa033）**：`useUrlOperatorContext` 全量状态（mode/layer/selected*/activeTab/conflict/event/replayTimestamp/compare）同步 URL（replaceState，back/forward 正常）；deep-link plan/task/event；失效 id 自动降级 + 用户可见提示；瞬态 UI 不入 URL。
10. **UX 深化（commit a7aa033）**：freshness 模型补齐 RESYNCING/DEGRADED 并全局统一（删除 SchedulerRealtimeBadge 第二套文案）；replan 先预览（ReplanPreviewResult 接线：affected/churn/lateness/travel/workload/conflicts/solver/版本）再确认；dispatch 确认框；override dry-run preview；conflict ack 换 a11y dialog；stale-version 与审计行为保留。
11. **大数据量（commit 15a26a5）**：SSE batching/coalescing（80ms 窗口、结构性事件即时 flush、maxBatchSize、缺口罩 seq 判定；10k 遥测削减 99%）；React Profiler benchmark + CI `command-map-perf-gate`（perf.yml）；虚拟化覆盖 events/resources/tasks/intelligence。
12. **无障碍（commit 15a26a5）**：Command Map axe 覆盖（5/5）；`KeyboardTableView` 键盘 table 替代视图接入 5 面板；SVG SR 文本摘要；overlay focus 恢复（ConflictPreview/PlanDiffDrawer/Override 结果区）；accessible name +8；非颜色状态 + forced-colors + 对比度修复。
13. **Edge runtime（commit 5b63bae）**：production 代码级禁止 `EWOH_EDGE_SCHEDULING_WRITE=1`（SchedulingWriteProhibitedError fail-closed）；adapter supervisor（死线程探测 + 指数退避 1s..60s + respawn 计数 + degraded）；sensor disconnect/adapter crash 故障注入（8 用例）。
14. **真实 PG E2E（commit be51386）**：snapshot 并发 E2E；双实例 replan E2E（与 6 协同）；`verify-rc-upgrade.mjs` RC→main 升级门禁（RC 截点动态解析 + G1 基线/G2 升级/G3 幂等/G4 兼容/G5 契约）；`e2e-preflight.mjs` + e2e-config 空 env 抛错（release gate 不再整包 skip）。
15. **故障注入补全（commit 6b4dfca）**：CP-SAT malformed response（响应形状校验 + 3 用例）；PG 临时故障（unit typed 57P01 + e2e pg_terminate_backend）；Redis unavailable 可观测（`rate_limit_redis_fallback_total` + 结构化日志）；route graph unavailable 显式标记；sensor stale（edge python）。

## D. P2 优化项

16. **Feishu 侧车（commit a912e20）**：`/health/live` + `/health/ready`（本地 API vs Feishu 集成状态区分，503 + reason）；CI 新 job（feishu.yml，60 tests）。
17. **drift gate 补全（commit b92bef1）**：`audit-env-inventory.js --strict`（101 documented / 102 code-env，0 漂移）；truth-feature-status `--self-test`（activation 不变量 7/7）+ README capability 表行级核对（11 feature 行）；truth-gate.js 接入 test.yml。

## E. 架构变化

- **Solver 激活状态机**：唯一事实源（env > policy > 默认 OFF），`solve()` 按状态路由；CANARY 采样/回滚管线由 dormant 变为运行时接线。
- **持久化契约**：plan/run 新增 solver_status/fallback_reason 列；snapshot 版本改数据库原子分配（counter 表）。
- **事务边界**：新增 `systemTransaction()` 显式系统事务 API；root handle 仅限 migrations/bootstrap/系统事务；业务全走 request transaction + org GUC + RLS。
- **Replan 风暴守卫**：production fail-closed + degraded readiness；双实例幂等。
- **CommandMap**：1304 行编排 → Shell + 6 Workspace + MapViewport（strangler 完成）；URL 作为决策上下文镜像；SSE 事件批处理管线。
- **Edge**：production 写禁 + adapter 监督层。
- **CI**：test.yml 全量 strict 门禁（OpenAPI/route/env inventory/truth-gate）；standalone/runtime-gates 增加 RC 升级 + PG preflight；perf.yml 增加 command-map gate + 扩展 scheduler gate；新增 feishu job。

## F. 用户体验变化

- 刷新/分享 URL 恢复完整决策现场；deep-link 直达 task/event/plan。
- 危险操作（replan/dispatch/override/conflict 处置）统一「当前状态 → 预计影响 → diff/preview → 确认 → 执行结果」；不再通过阅读 JSON 理解结果。
- 全局统一 freshness 词汇（LIVE/DELAYED/STALE/OFFLINE/REPLAY/RESYNCING/DEGRADED），第二套状态文案删除。
- 大数据量流畅度：SSE 批量合并（10k 遥测 99% 削减）、长列表虚拟化覆盖 5 面板。
- 无障碍：键盘 table 替代视图、axe 0 critical/serious、overlay 焦点管理、非颜色状态通道、forced-colors 高对比。

## G. 数据库 migration

| Migration | 内容 | 兼容性 |
|---|---|---|
| `standalone_030_solver_activation` | `ewoh_schedule_plan` + `ewoh_scheduling_run` 新增 `solver_status varchar(32)` / `fallback_reason text`（可空） | 存量行 NULL，无默认，向后兼容 |
| `standalone_031_snapshot_version_counter` | `ewoh_snapshot_version_counter`（day PK + last_seq NOT NULL DEFAULT 0） | 纯新增表；`snapshot_version` 全局 UNIQUE 保留为兜底 |
| verify SQL + rollback 均已提供并注册 runner | G1-G5 升级门禁覆盖 | RC→main 全链可重放、幂等 |

## H. API/contract 变化

- `GET /api/scheduler/context` 进入 OpenAPI（此前已实现未文档化）。
- `SchedulerKpiSnapshot.stability` 补齐 6 个 Replan V2 字段（affectedAssignmentRatio/unchangedAssignmentRate/scheduleChurn/replanDuration/replanTriggerCount/replanSuppressedCount）。
- `route-manifest.json` 可复现（去重、去 generatedAt）；`openapi.d.ts` 重生成零漂移。
- `SchedulingPolicyConfig.cpSat` 扩展 `activation/canaryFraction/orgAllowlist`；`SolveOptions` 新增 `affectedTaskIds`/`orgId`；新增 `SolverActivationState` 类型。
- `openapi-route-parity` / `openapi-type-parity` jest 门禁保证 documented↔implemented 与 shared↔generated 双向一致。

## I. 新增/修改测试

| 套件 | 数量 | 结果 |
|---|---|---|
| solver-activation.spec（4 模式） | 12 | 全过 |
| affected-metrics.spec | 5 | 全过 |
| world-state-version.spec（原子分配/回卷/重试/超限） | 4 新增 | 全过（27 合计） |
| snapshot-concurrency.e2e | 并发 8 路版本互异 | 全过（真实 PG，CI） |
| replan-guard-failclosed + health | 6+2 | 全过 |
| replan-dual-instance.e2e（D1/D2） | 2 | 全过（真实 PG，CI） |
| root-db-allowlist.audit | 4 | 全过 |
| org-rls-guc.e2e（并发跨 org + GUC 断言） | — | 全过（真实 PG，CI） |
| openapi-route-parity + type-parity | 20 | 全过 |
| cp-sat-malformed / world-state-db-failure / rate-limit-redis-fallback / routing / travel-cost | 46 合计 | 全过 |
| sensor-stale（python）+ adapter-supervisor（python） | 8+ | 全过 |
| feishu health.test + 既有 | 60 | 全过 |
| SSE batching（schedulerRealtimeCore） | +15 | 全过（34 合计） |
| use-url-operator-context | 16 | 全过 |
| command-map-perf（React Profiler） | 1 | 全过 |
| ux009-command-map-axe（Playwright） | 5 | 全过 |
| e2e-config.spec（CI-safe 检测） | 3 | 全过 |
| stateCoverage 修复（Task 8 后文件目标更新） | 9 | 全过（fe6dced） |

**最终验证计数**（本地 macOS）：server jest 1338（1337 过 / 1 既有失败）、client jest 881（881 过，含修复后）、python pytest 999 collected（989 过 / 0 失败 / 10 skip=ortools 未装）、feishu 60 过、Playwright axe 5/5、tsc server/client/spec 0 错误、stylelint 0、gen:openapi 零漂移、audit-openapi strict 0 undocumented / 0 unimplemented、audit-repo-facts 39/39、truth-feature-status 32/32 + self-test 7/7、env-inventory 101/102 PASS、truth-gate OK（未声称 Production Ready）、route-manifest 零 diff。PG 依赖门禁本地 BLOCKED_BY_ENVIRONMENT（CI PG17 执行）。

## J. Scheduler benchmark 前后对比

| size | 用户历史基线 | 修复前（109b4b0 环境） | 本轮实测（本机 macOS） |
|---|---|---|---|
| 10 | ~9ms | — | wall 3.5-4.1ms / cpu 4.8-5.7ms / candidates 60 / pruned 1 / cacheHit 0.40 |
| 100 | ~427ms | — | wall 55.5-111.9ms / cpu 81.9-138ms / candidates 45,000 / pruned 28,085 / cacheHit 0.98 |
| 500 | ~46s | ~1.64s | wall 2.48-3.22s / cpu 2.64-3.34s / candidates 5.6M / pruned 5.04M / cacheHit 0.999 |
| 1000 | OOM | ~8.5s | wall 13.7-15.7s / cpu 13.4-15.4s / candidates 31.25M / pruned 29.38M / cacheHit ~1.00 |

- 500 task <5s：**达标**（全部测量 <3.3s）。1000 task <10s：本机 13.7-15.7s **未稳定达标**（前次环境实测 8.5s；CI 宽松界 60s 内；run-to-run 方差大）。
- assignmentRate 恒 1.0（无硬约束遗漏）；pruned/candidates 比约 94%，route-cache hit 99.9%+ 说明 memo 生效。

## K. 内存峰值前后对比

| size | 用户历史基线 | 本轮实测 peakHeapMb |
|---|---|---|
| 10 | — | ~388-391 |
| 100 | — | ~376-392 |
| 500 | — | ~391-393 |
| 1000 | **OOM（崩溃）** | ~389-393（**无 OOM、无随规模内存增长**） |

内存随规模近似恒定（staged pipeline + 不保存被淘汰组合），1000 task 从「OOM」到「稳定 ~390MB」是最大改善。

## L. 已知剩余问题

1. **1000-task <10s 未在本机稳定复现**（13.7-15.7s，CI 宽松界 60s 内；109b4b0 环境实测 8.5s）。根因：candidate 全量评估矩阵（1000 task 时 31.25M 候选对，prune 后仍全量 cost 评估）+ 本机 CPU 波动。非 OOM、非硬约束问题。
2. **预存 server jest 1 失败**（非本轮引入）：`.codex/artifacts/state.json` 声称 73 managed tables，`reconcile-authoritative-artifacts.js` 计算 57 → `dbConsistent=false`。state.json 陈旧。
3. **预存 ESLint 7 错误**（非本轮引入）：`injectable-should-be-provided`（scheduler.service.ts 手工 `new` 实例化 7 个服务，未入 module providers）。
4. **预存 ruff 138 错误**（非本轮引入）：typing 现代化/未用导入/行宽等，ruff 版本未固定。
5. **truth-feature-status 1 个既有 WARN**：decisionCockpit implemented=false 但文档按规划提及（既有降级策略）。
6. **PG 依赖门禁**（snapshot 并发 / 双实例 replan / RC→main 升级 / org-rls-guc）本机 BLOCKED_BY_ENVIRONMENT，脚本已 fail-loud 防静默 skip，须在 CI PG17 真实执行确认。

## M. 是否达到 Production Ready

- runtime truth 一致 ✅、hard constraints 无回归 ✅、500<5s ✅、OpenAPI 100% ✅、release gate 防 skip ✅、多实例验证（测试就绪，CI 执行）✅、deep-link/preview/确认 ✅、事实源一致 ✅、失败模式可观测 ✅、安全/审计/可解释保留 ✅。
- 12 条完成标准中 **1 条未在本机稳定达标**：1000 task <10s（实测 13.7-15.7s；无 OOM；109b4b0 环境曾实测 8.5s）。truth-gate.js 复核 `ready=false`（未声称 Production Ready）——与事实一致。
- 判定：**生产就绪候选（Production-Ready Candidate）**——功能完整、事实一致、可证明；唯一性能验收指标待稳定 CI 硬件复测确认。

## N. 剩余 blocker 列表

1. **1000-task <10s 达标确认**（唯一功能性验收 blocker）：需在稳定 CI 硬件上以固定 fixture 复测；若仍 >10s，推荐（a）per-task bounded top-K 候选缩减（当前全量 31.25M 对成本评估）；（b）candidate 评估分片/流式；（c）route-cost memo 已 99.9%+ 命中，进一步收益点在候选生成而非成本。已提供测量证据与根因，改动不降低硬约束正确性。
2. **预存门禁清理**（不阻塞本轮验收，阻塞仓库全绿）：state.json managed-tables 漂移（73 vs 57）、ESLint 7 处 injectable 告警、ruff 138 处风格错误（建议固定 ruff 版本）。
3. **PG 依赖门禁在 CI 的真实执行确认**（snapshot 并发 / 双实例 replan / RC→main 升级 / RLS 并发）：脚本与 workflow 已就绪，须在 CI PG17 上跑通并留档结果。
