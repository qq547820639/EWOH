# Tasks

> 基线：`main` @ `9283b8b`。原则：以真实代码/测试/构建产物验证为准；真实环境不可用 → BLOCKED + 一键命令。
> 分工：T0 为基线先行；T1–T3 为 P0（性能/重构/RLS，互不依赖可并行）；T4–T8 为 P1（CommandMap/Cockpit/
> CP-SAT/Shadow/Gates，其中 T4/T5 有先后依赖）；T9–T11 为 P2（Edge/Feishu/Truth Gate，可并行）；
> T12 为验收与交付（依赖全部）。

- [x] Task 0: 建立当前事实基线（六维事实矩阵）
  - [x] 记录环境指纹（branch/HEAD/time/OS/Node/Python/缺失工具清单）
  - [x] 递归核对 15 个目录（edge_platform/spark server+client+shared+test/feishu/contracts/openapi/db/catalog/deploy/docs/scripts/tools/security/tests/.github）与 main 最新状态
  - [x] 产出 `docs/reviews/deepen-scale-fact-baseline.md`：CODE IMPLEMENTED / TESTED / DEPLOYABLE / PRODUCTION ENABLED / RUNTIME VERIFIED / DOCUMENTED 六维矩阵，逐项列出证据（文件+测试+CI）
  - [x] 确认 delivery/ 冻结、ui/command_map/ 归档、output/release 不作为业务事实源
  - [x] 运行既有可运行门禁基线并记录（typecheck/lint/scheduler jest/client jest/python pytest/openapi drift）

- [x] Task 1 (P0): Scheduler 大规模性能（staged candidate + memoization + benchmark）
  - [x] 用现有 `scripts/benchmark-scheduler.ts` 复现 10/100/500/1000 基线并记录 before（wall/peak heap/candidate count/assignment rate/solverStatus；1000 OOM 已复现：exit 134）
  - [x] profiling：CPU/heap/allocation/candidate 生成次数/拒绝候选数/route cost 调用/station feasibility 调用/trace 分配/constraint 求值
  - [x] 定位 O(T×P×D×S) 真实热点（候选枚举 + route/station 重复调用 + trace 全量构造）
  - [x] 实现 staged candidate generation（skills prefilter → availability index → capability/status index → spatial/station prefilter → reservation prefilter → Top-K bound → expensive route/scoring → deterministic ranking）
  - [x] 实现 run-local indexes（personBySkill/availablePersons/deviceByCapability/availableDevices/stationCapacity/activeReservations/taskConstraints）+ RouteCost/TravelCost 确定性 memoization
  - [x] explanation trace 改 compact rejection code（CompactReject + 有界缓冲 + rejectedHardTotal），UI 需要时 materialize
  - [x] incremental replan fast-path：reuseBaseline（默认 OFF，任务级复验后直接采纳，无效回退全量枚举）
  - [x] 语义保持回归：parity/invariant/capacity/skills ALL-ANY/capabilities/locked-excluded-preferred/reservation/safety-critical/deterministic replay 全部通过（12 个 oracle spec 81 tests）
  - [x] 永久 benchmark 支持 10/100/500/1000（wall time/peak heap/candidate count/assignment rate/solverStatus）；500=1.64s（<5s）、1000=8.5s（<10s）、无 OOM
  - [x] benchmark 接入 CI（perf.yml scheduler-benchmark-gate，500>20s/1000>60s/OOM 硬失败），invariant spec 接入

- [x] Task 2 (P0): scheduler.service.ts 与 heuristic solver Strangler Refactor
  - [x] 补 characterization tests（scheduler-facade-characterization.spec.ts 56 tests，重构前后行为快照一致）
  - [x] 从 scheduler.service.ts 抽取 SchedulerRunOrchestrator / SchedulerQueryService / SchedulerPlanApplicationService / SchedulerReplanApplicationService / SchedulerConstraintApplicationService / SchedulerEventApplicationService / SchedulerDispatchApplicationService
  - [x] scheduler.service.ts 降级为 facade（2288→398 LOC），公开签名不变
  - [x] heuristic solver 已由 Task 1 拆分为 staged pipeline（CandidateEnumerator/FeasibilityEvaluator/AssignmentScorer/TraceCollector 语义对齐）
  - [x] 全量 scheduler spec（655 tests）通过 + tsc 通过；无循环依赖/隐式共享可变状态引入

- [x] Task 3 (P0): Scheduler V2 多租户/RLS 边界
  - [x] 11 张表逐一定性 GLOBAL_SHARED / TENANT_SCOPED / DERIVED_TENANT_OWNERSHIP（outbox/world_state_snapshot=GLOBAL_SHARED；8 张 org-scoped=RLS；assignment_event=DERIVED）
  - [x] 正式 ADR：docs/decisions/ADR-004-scheduler-tenancy.md
  - [x] TENANT_SCOPED 双保险核验（RLS + 应用层 + request GUC app.current_org_id）
  - [x] child table 数据库级验证：standalone_028 assignment_event 派生 org trigger + verify 不变量 + rollback
  - [x] 真实 PostgreSQL multi-tenant E2E：scripts/verify-scheduler-multitenant.mjs（Org A 创建，Org B 不可 list/get/update/delete/approve/dispatch；service_role 行为；CI standalone.yml 接线）
  - [x] service_role 预期行为测试（rls-policy.spec.ts + rls-org-filter.audit.spec.ts 10/10）

- [x] Task 4 (P1): CommandMap Store 与唯一状态源
  - [x] useCommandMapController + CommandMapStore（selection/viewport/mode/replay/scheduler-realtime/decision-context 六 slice）
  - [x] selectedTaskId/selectedPlanId/selectedEntityId 唯一状态源；`plans[0]` 在 client/src 清零（grep=0；SchedulePanel L437 修复）
  - [x] selector/memoization：SSE 单事件仅写 schedulerRealtime slice，测试断言不重渲染其他 slice 订阅者
  - [x] 大量 entity/task：viewport culling（viewportCulling.ts）+ layer memo + list virtualization（SchedulePanel/ConflictCenterPanel）
  - [x] 纯展示转换 Web Worker：跳过（客户端无既有 worker 模式，避免新增构建复杂度，已记录）

- [x] Task 5 (P1): Decision Cockpit 与 Data Freshness
  - [x] 统一 Decision Context（WHAT HAPPENED/WHY/IMPACT/SYSTEM DECISION/WHY THIS ASSIGNMENT/WHY NOT OTHERS/COST/RECOMMENDED ACTION/ACTIONS），仅消费服务端字段，前端不推业务规则
  - [x] "Why did this task move?"：taskMoveExplainVM 因果链 + unchanged-task 展示
  - [x] 全局 Data Freshness Model（LIVE/DELAYED/STALE/OFFLINE/REPLAY/SHADOW + lastUpdatedAt/source/lag/reason）；CommandMap 顶部 indicator；SSE 断开不呈现 LIVE（测试）
  - [x] Solver 状态链显式展示（CP-SAT requested → UNAVAILABLE/TIMEOUT/FALLBACK → Heuristic fallback；HEURISTIC/OPTIMAL/FEASIBLE 对应链）
  - [x] 既有面板能力全部保留（ConflictCenter/TaskIntelligence/RejectedCandidateExplain/ReplanPreview/PlanCompare/Override）

- [x] Task 6 (P1): CP-SAT Production Activation（OFF→SHADOW→CANARY→PRODUCTION）
  - [x] worker 运行级能力补齐：health/readiness、并发上限（线程池+信号量 429）、请求超时（TIMEOUT）、max problem size（413）、memory guard（ru_maxrss）、/metrics、X-Request-ID 关联、SIGTERM 优雅停机
  - [x] SHADOW：solveShadowCompare 双跑对比指标；shadow 结果 isShadow + ShadowPlanGuard 拒绝 approve/dispatch/reserve；默认 OFF 行为不变
  - [x] CANARY：handleShadowCompareDivergence 硬约束分歧自动 setCanaryFraction(0) + outbox 事件；manual rollback 既有
  - [x] productionEnabled 恒 false（feature-status.yaml 如实；代码级 ACTIVATION_LADDER 常量 + 门禁注释）
  - [x] 本机无 ortools → 真求解 UNAVAILABLE 路径测试（28 python + 17 TS tests）

- [x] Task 7 (P1): Prediction Shadow Learning 持久化
  - [x] migration standalone_029 prediction_shadow_observation（18 列/3 索引/retention 注释）+ apply/verify/rollback/re-apply 注册
  - [x] ShadowEvaluator 持久化写路径（内存 ring buffer 保留为 fast cache）+ backfill 优先 correlation_id→task_id→(type,createdAt)
  - [x] 评价聚合：MAE/RMSE/p50/p95/coverage/fallbackRate/calibration/modelVersion/site-org/rolling window（aggregatePersisted）
  - [x] 重启后历史保留（持久化语义 + 测试）；advisory-only 不变（不改变正式调度结果）
  - [x] 版本化策略/快照版本随样本记录（policy_version/snapshot_version/model_version 字段）

- [x] Task 8 (P1): Runtime Gates 自动闭环（尽力而为）
  - [x] GitHub Actions ephemeral kind：helm-kind-gate job（30min 硬上限：install/health/smoke/upgrade/failed-upgrade/rollback/post-rollback/data integrity + canary 注入失败自动回滚）
  - [x] soak-load-gate job（25min 硬上限：SOAK_REQUESTS=2000 + soak-scheduler-events.js 500 事件风暴 + SSE 断线重连 240s 兜底）
  - [x] 本地无法执行项标记 BLOCKED + 一键命令 + 证据路径；docs/runtime-gates.md 状态更新（G5/G8/G9→CI 自动化）
  - [x] 全部 job 设硬上限与超时；无 continue-on-error 掩盖失败；无伪造 PASS

- [x] Task 9 (P2): Edge server 模块化
  - [x] 8 个 route domain 提取（health/auth/telemetry/inference/world/scheduler/admin/replay）
  - [x] routing/serialization/auth-middleware/service-invocation/lifecycle 分离；无大型 Web Framework（stdlib http.server）
  - [x] HTTP/SSE 契约完全兼容（字节级；characterization 23 tests + 13 边界路径实网 spot-check）
  - [x] Python pytest 全绿（799 passed）

- [x] Task 10 (P2): Feishu sidecar 审计与契约
  - [x] 确认既有 async execFile/timeout/concurrency/breaker 不重复实现
  - [x] 审计项闭环：retry backoff+jitter（新）、队列上限（新）、sync 分页（修）、凭据 env 优先（统一 resolveBaseToken）、优雅关停排空（修+信号量漂移修复）、webhook 幂等/遥测批量/审计完整性（核实）
  - [x] 单实例边界写入部署/运行时契约（README 七节 + docs/operations/feishu-sidecar-runtime.md），不迁移 PostgreSQL

- [x] Task 11 (P2): Repository Truth Gate
  - [x] feature-status.yaml（11 项六维事实；cpSat.productionEnabled=false、predictionShadow 非生产影响 如实）
  - [x] CI 校验：truth-feature-status.js R1-R7（manifest 结构/生产门禁/文档一致性/OPEN-DECISIONS/版本一致性/CP-SAT 漂移守卫/OpenAPI 零漂移）24/24 PASS；test.yml 接线
  - [x] 漂移修正：docker-compose.cpsat.yml 补齐、Dockerfile ortools 版本锁定、CHANGELOG 精确化、OPEN-DECISIONS lark-cli 关闭、route-manifest 重新生成、state.json 表计数对齐

- [x] Task 12: 全量验证与交付报告
  - [x] 运行全部可运行验收命令并记录（server 655 tests / client 832 tests / python 971+10 / feishu 54 / openapi 零漂移 / audit-repo-facts 39/39 / truth-gate 24/24 / benchmark before→after；DB/Helm/CP-SAT 真求解 → BLOCKED+命令）
  - [x] 产出 docs/reviews/deepen-scale-cockpit-closure-report.md（15 项交付要素）
  - [x] 更新 CHANGELOG / ADR-004 / feature-status.yaml / docs/runtime-gates.md
  - [x] 提交并推送 origin/main（排除调试残留与用户既有未提交改动）

# Task Dependencies
- Task 0 是基线，先行。
- Task 1/2/3 相互独立，可在 Task 0 后并行（Task 2 的 solver 拆分与 Task 1 的 staged pipeline 需共享设计，顺序执行以避免冲突）。
- Task 4 先于 Task 5（Decision Cockpit 依赖 Store 唯一状态源）。
- Task 6/7/8 相互独立，可在 Task 3 后并行（均依赖 DB 事实源）。
- Task 9/10/11 相互独立，可并行。
- Task 12 依赖 Task 1–11 全部完成。
