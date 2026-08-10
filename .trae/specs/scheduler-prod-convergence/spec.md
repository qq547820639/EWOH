# Command Map 生产级收敛（Scheduler Prod Convergence）Spec

> change-id：`scheduler-prod-convergence`
> 日期：2026-08-10 ｜ 依据：用户 25 章需求（第四次提交同源需求）+ 对当前 main 的实际代码基线核验
> 前置 spec（已完成并提交）：`command-map-scheduling-cockpit`（Aug 8）、`command-map-scheduler-upgrade`（Aug 10，Deepen Tasks 1-6，commit d48d6cc）、replan v2 系列（commit 1c9d2bb→f68dcdb）

## Why

用户再次提交"指挥地图 → 生产级智能调度驾驶舱"系统性升级需求，并明确要求：**先完整扫描当前仓库输出实际代码基线 + P0 问题定位，随后直接进入 P0 改造**。

经对 main 头代码的逐项核验，25 章需求中的绝大部分已在既有交付中落地（见下"基线核验结论"）。本 spec **不重复实现已完成能力**，只收敛经代码确认仍存在的真实缺口，以最小、可验证的增量交付，严格遵循"先补测试 → 改代码 → 回归 → 提交 main"。

**边界不变**：NestJS 是生产调度唯一写 authority；Python Edge advisory-only（`scheduler_service.py` 已带 `advisory_only` 标记与写路径守卫）；Safety hard constraint 不可被 override 绕过；STALE/UNKNOWN 不视为 AVAILABLE；不引入无数据来源的虚假数据；不破坏既有 migration 历史（新增一律增量 migration）。

## 基线核验结论（P0 问题定位）

| 用户需求章节 | 现状（代码证据） | 结论 |
|---|---|---|
| §5.1 调度权威/数据一致性 | NestJS 写 authority；Edge advisory_only 守卫；plan 记录 snapshotVersion/policyVersion/solverVersion/solverStatus/fallbackReason/effectiveConstraintsHash | ✅ 已满足 |
| §5.2 任务优先级 | PriorityEngine + PriorityDecision(rank/reasonCodes/policyVersion) + SchedulingEventImpact scope 化 + policy 版本化 | ✅ 已满足 |
| §5.3 候选匹配 | CandidateEngine + 结构化 rejectReasons + Eligibility 硬约束先行 | ✅ 已满足 |
| §5.4 路线 STRICT/DEGRADED/ADVISORY | 仅 route_graph / euclidean_fallback 显式降级（fallbackReason/dataQuality/penalty），**无 STRICT / ADVISORY 策略模式** | ⚠️ 缺口 |
| §5.5 Solver | SchedulingSolver 抽象 + heuristic 确定性 + CP-SAT timeout/status/fallback + objective breakdown + deterministic fixture + shadow eval | ✅ 已满足 |
| §5.6 多目标 | 8 权重 objective breakdown + weights 落库 | ✅ 已满足 |
| §5.7 重排稳定性 | ReplanConfig（debounce/minInterval/maxPerWindow/maxPropagationDepth/maxAffectedTasks）+ storm guard + churn objective；**缺 freezeWindowMinutes 与 minimumObjectiveImprovement** | ⚠️ 部分缺口 |
| §5.8 冲突生命周期 | ConflictLifecycleStatus(OPEN/ACKNOWLEDGED/RESOLVED/SUPPRESSED) + query 纯读 | ✅ 已满足 |
| §5.9 Dispatch 原子性 | DispatchCoordinator 单事务 12 步 + CAS + outbox + audit | ✅ 已满足 |
| §5.10 实时状态 | durable outbox + SSE Last-Event-ID/replay/gap/resync/org isolation；**仍为 2s DB polling，无 Postgres LISTEN/NOTIFY 或 Redis 低延迟 wake-up** | ⚠️ 缺口 |
| §5.11 React Command Map | SchedulerRealtimeProvider 单 SSE 连接 + 统一 UI state + selectPlanForLayer 不回退 plans[0] | ✅ 已满足 |
| §5.12-5.13 可视化/人工干预 | OverridePreview + lock/exclude/prefer/boost/retime + plan compare + 图层 | ✅ 已满足 |
| §5.14 可解释性 | DecisionTrace + CandidateExplain + RejectedCandidateExplain | ✅ 已满足 |
| §5.15 反馈学习 | Execution/Feedback/KPI/ShadowPolicy/PolicyReplay/Gate/PredictionShadow | ✅ 已满足 |
| §6.1 生产依赖 optional fallback | `world-state.service.ts:42`（ResourceProjectionService 可选+旧直读回退）、`plan.service.ts:53-60`（feedback/constraintLoader/outbox/replan 可选）、`dispatch-coordinator.service.ts:46-47`（feedback/policy 可选）、`solver.service.ts:53-56`（metrics/candidateEngine 可选） | ⚠️ 缺口 |
| §6.3 TS↔Python 契约 parity test | 仅有 Python worker health/错误测试与 TS 单测 mock；**无跨语言 golden fixture parity test** | ⚠️ 缺口 |
| §6.4 历史 `ui/command_map/` archived 标记 | 该目录无 README/archived 标记 | ⚠️ 缺口 |
| §8 P0.3/P0.4 SSE 单例、UI state 统一 | 已由 Deepen Task 2 完成（SchedulerRealtimeProvider） | ✅ 已满足 |

## What Changes（本轮范围）

1. **P0-1（§6.1）生产关键依赖 required 化**：`WorldStateSnapshotService.resourceProjectionService`、`PlanService`（feedback/constraintLoader/outbox/replan）、`DispatchCoordinatorService`（feedback/policy）、`SolverService`（metrics/candidateEngine）从 `@Optional` 改为 required，删除静默回退旧实现分支；单测改为显式注入 mock/test module。`cpSatConfig` 保持可选（CP-SAT 缺失时按 §5.5 显式 UNAVAILABLE/FALLBACK 降级，属合规行为而非静默回退）。
2. **P0-2（§5.4）RouteCost STRICT / DEGRADED / ADVISORY 策略**：新增 `RouteCostMode` 策略（`SchedulingPolicyConfig.routeCostMode`，缺省 `DEGRADED` 保持现状）：
   - `STRICT`：route graph 不可达/不可确认 → 候选 infeasible（`route_infeasible`），禁止 euclidean 兜底；
   - `DEGRADED`（现状）：euclidean fallback 允许，带 `fallbackReason`/`dataQuality` + 惩罚；
   - `ADVISORY`：euclidean fallback 仅作参考；**safety-critical 任务带降级路径不得自动 dispatch**（Dispatch 层 fail-closed）。
3. **P0-3（§6.3）TS↔Python 契约 golden fixture parity test**：新增跨语言 golden fixture（`tests/golden-fixtures/scheduler-contract.golden.json`），TS（jest）与 Python（pytest `cpsat/contract.py`）两侧各自序列化/反序列化并断言与 golden 深等、字段不增不减、枚举值一致。
4. **P0-4（§6.4）历史 `ui/command_map/` archived 标记**：新增 `ui/command_map/README.md` 明确标注 archived / non-production，生产事实源为 `ewoh-spark-app/client/src/pages/CommandMap/`。
5. **P1（§5.7）ReplanStabilityBudget 补全**：`ReplanConfig` 增加 `freezeWindowMinutes`（窗口内近期 assignment 冻结）与 `minimumObjectiveImprovement`（低于阈值且无安全/冲突修复收益时抑制重排，emit `replan.suppressed`）；critical/safety 触发与既有冲突修复不因阈值被抑制。
6. **P2（§5.10）Outbox → Postgres LISTEN/NOTIFY 低延迟 wake-up**：新增增量 migration `standalone_024_scheduler_outbox_notify`（`ewoh_outbox` AFTER INSERT trigger → `pg_notify('scheduler_outbox')`）；`SchedulerStreamService` 增加可选 LISTEN 连接（收到通知即触发一次 poll），durable outbox / sequence / replay / gap 语义不变，2s polling 保留为兜底，wake-up 可配置开关。

## Impact

- 受影响代码：
  - `ewoh-spark-app/server/modules/scheduler/world-state.service.ts`、`plan.service.ts`、`dispatch-coordinator.service.ts`、`solver.service.ts`、`scheduler.module.ts`（必需化 + 显式测试注入）
  - `ewoh-spark-app/shared/scheduler.ts`（`RouteCostMode`、`SchedulingPolicyConfig.routeCostMode`、`ReplanConfig.freezeWindowMinutes/minimumObjectiveImprovement`）
  - `ewoh-spark-app/server/modules/scheduler/travel-cost.service.ts`（mode 感知成本）、`dispatch-coordinator.service.ts`（ADVISORY safety fail-closed）、`replan-coordinator.service.ts`（stability budget）、`scheduler-stream.service.ts`（LISTEN/NOTIFY wake-up）
  - 新增 `tests/golden-fixtures/scheduler-contract.golden.json`、`tests/test_ts_python_contract_parity.py`、`ui/command_map/README.md`
  - 新增 `db/migrations/standalone_024_scheduler_outbox_notify.{sql,rollback.sql}` + `db/verify/standalone_024_scheduler_outbox_notify.verify.sql`
- 受影响既有 spec：`command-map-scheduler-upgrade`（已完成，本 spec 在其上增量）。

## ADDED Requirements

### Requirement: 生产依赖 required 化
核心调度服务 SHALL 将生产事实依赖（ResourceProjectionService、OutboxService、SchedulingFeedbackService、ReplanCoordinatorService、SchedulerMetricsService、CandidateEngineService、SchedulingPolicyService、ConstraintLoaderService）作为必选构造依赖注入；不得存在"可选注入 + 静默回退旧实现"的生产路径。

#### Scenario: 生产与测试注入语义
- **WHEN** 生产模块启动
- **THEN** 上述依赖全部由 `scheduler.module.ts` 提供，无旧实现回退分支被执行
- **WHEN** 单测直接 `new X(...)` 构造
- **THEN** 必须显式传入 mock/真实依赖，缺失时编译期/运行期报错而非静默回退

### Requirement: RouteCost 三级策略
系统 SHALL 通过版本化 `SchedulingPolicyConfig.routeCostMode` 控制路线成本模式：STRICT（route graph 不可达即 infeasible）、DEGRADED（euclidean 显式降级 + 标记 + 惩罚）、ADVISORY（降级仅参考，safety-critical 不得自动 dispatch 降级路径）。

#### Scenario: STRICT 拒绝降级候选
- **WHEN** `routeCostMode=STRICT` 且任务×候选无 route graph 路径
- **THEN** 候选标记 infeasible（`route_infeasible`），不进入 feasible set

#### Scenario: ADVISORY 阻断安全派工
- **WHEN** `routeCostMode=ADVISORY` 且 safety-critical 任务 assignment 路径为 euclidean_fallback
- **THEN** dispatch 拒绝（明确错误码 `SAFETY_CRITICAL_DEGRADED_ROUTE`）；非安全任务可正常派工并展示降级标记

### Requirement: TS↔Python 契约 golden parity
系统 SHALL 提供跨语言 golden fixture parity 测试，TS（`SolverRequest`/`SolverResponse`）与 Python（`cpsat/contract.py`）对同一 golden JSON 序列化/反序列化结果一致，枚举值集合一致，防止 `shared/scheduler.ts` 与 Python scheduler models 长期手工漂移。

#### Scenario: 两侧同一 golden 通过
- **WHEN** jest 与 pytest 分别加载同一 golden fixture
- **THEN** TS 侧字段全集与 golden 一致（无缺字段/无多余字段）；Python `SolverRequest.from_dict` 可解析全部字段且 `to_dict` 往返深等；`SolverStatus` 枚举值集合一致

### Requirement: 历史 Command Map 归档标记
历史静态原型 `ui/command_map/` SHALL 在目录内以 README 明确标注 archived / non-production，生产 Command Map 事实源为 `ewoh-spark-app/client/src/pages/CommandMap/`。

### Requirement: ReplanStabilityBudget 补全
`ReplanConfig` SHALL 支持 `freezeWindowMinutes`（冻结窗口内近期执行/锁定 assignment）与 `minimumObjectiveImprovement`（无安全/冲突修复收益时的最低目标改进阈值），抑制非关键重排引起的计划震荡。

#### Scenario: 冻结窗口与最低改进阈值
- **WHEN** assignment 在 freezeWindow 内处于 executing/dispatched/locked
- **THEN** 该 assignment 进入冻结集，不参与重排移动
- **WHEN** 非 critical 触发且候选目标改进 < minimumObjectiveImprovement 且无冲突/硬约束待修复
- **THEN** 重排被抑制并 emit `replan.suppressed`（含 reason）
- **WHEN** 触发为 safety/critical 或存在待修复冲突
- **THEN** 阈值不生效，正常重排

### Requirement: Outbox 低延迟 wake-up（P2）
系统 SHALL 在 durable outbox + SSE replay 语义不变的前提下，提供 Postgres LISTEN/NOTIFY 低延迟 wake-up：`ewoh_outbox` 插入后触发 `pg_notify`，`SchedulerStreamService` 收到通知立即 poll；NOTIFY 不可用时自动回退 2s polling 兜底。

#### Scenario: 通知驱动 + 兜底
- **WHEN** outbox 有新事件提交
- **THEN** LISTEN 连接收到通知并触发一次 poll，事件按 sequence 推送（延迟低于轮询间隔）
- **WHEN** LISTEN 连接失败/未启用
- **THEN** 保持轮询兜底，SSE 功能不中断；通知事件不作为唯一事实源

## MODIFIED Requirements

### Requirement: 路线成本显式降级（原 route_graph/euclidean_fallback 双态）
扩展为三态策略（STRICT/DEGRADED/ADVISORY）；DEGRADED 行为与现状完全一致（默认值），STRICT/ADVISORY 为新增显式语义。`CandidateRouteCost`/`Route.fallbackReason`/`dataQuality` 字段不变。

### Requirement: Replan 风暴治理（原 ReplanConfig）
`ReplanConfig` 新增 `freezeWindowMinutes`（缺省 15）与 `minimumObjectiveImprovement`（缺省 0.02，即 2%）；既有字段（replanDebounceMs/minimumReplanIntervalMs/maximumReplansPerWindow/maxPropagationDepth/maxAffectedTasks）语义不变。

## REMOVED Requirements
无（本轮全部为增量/修复）。

## 明确不做（ROADMAP，仅记录）
- CP-SAT canary 灰度激活：维持 shadow 模式，待 ADR-003 人工决策。
- SchedulerService/CommandMap 巨型文件拆分：遵循 strangler，不做大爆炸重写。
- 前端重算后端权威逻辑、引入无来源虚假工厂数据：禁止。
- Redis Streams 替代 Postgres NOTIFY：本轮不做（NOTIFY 已满足低延迟 wake-up，避免新增基础设施）。
