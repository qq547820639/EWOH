# EWOH Command Map 智能调度升级 — 产品需求文档（PRD）

> 文档编号：PRD-EWOH-CM-2026-08-10
> 日期：2026-08-10 ｜ 版本：v1.0 ｜ 状态：待评审
> 产品经理：许清楚（software-product-manager）
> 项目名称：command_map_upgrade
> 编程语言/技术栈：NestJS（ewoh-spark-app/server）+ React（client）+ PostgreSQL/RLS + Python CP-SAT Worker
> 依据：用户原始需求（25 章）+ 架构师现状核验（docs/scheduler-commandmap-upgrade/01-current-state-review.md）+ 增量架构设计（02-architecture-design.md）+ Phase 0 走读（docs/scheduler-phase0-walkthrough.md）+ 交付报告（04-delivery-report.md）

---

## 1. 执行摘要

### 1.1 背景

EWOH 是工厂具身智能调度平台：NestJS（ewoh-spark-app/server）为生产调度 authority（唯一写路径），Python Edge（src/edge_platform）为 advisory-only / degraded 兜底，PostgreSQL + RLS 多租户隔离。现有 **Scheduler V2** 已具备较强基础：WorldStateSnapshot、Priority Engine、Eligibility、Route/TravelCost（含显式 degraded fallback）、确定性 Heuristic Solver、CP-SAT（实验性）、Reservation、Plan lifecycle、Conflict/ImpactAnalyzer/局部 Replan、DecisionTrace、SchedulingPolicy（版本化）、Shadow policy、Feedback/KPI、SSE（Last-Event-ID/gap resync）、React Command Map（task/resource/reservation/plan/route/conflict/risk 图层）。

用户提出 25 章升级需求，核心诉求为：**先保证输入正确（状态一致性）→ 再完善调度决策（Heuristic 完整化）→ 逐步引入 CP-SAT Shadow/Canary → Decision Cockpit → 反馈学习闭环**，且要求"每个 Phase 独立提交可运行改动"。

### 1.2 目标

| 目标 | 说明 |
|---|---|
| G1 | **状态一致**：所有消费者（WorldStateSnapshot / Command Map / Scheduler / Dispatch）共享唯一、带版本与新鲜度标记的 Resource State；坐标、任务需求、人工约束等输入真实落库且不丢失。 |
| G2 | **决策正确可解释**：Heuristic 求解器完整化（station 为决策变量、真实容量/队列、setup/changeover 成本、魔法数入策略），硬软约束严格分离，每个 Assignment 输出完整 DecisionTrace，确定性可重放。 |
| G3 | **变更可控**：通过 Override Preview、冲突查询纯读、局部重排（禁止全厂重排）等机制保证人工可介入、影响可预估、审计可追溯，不破坏现有 API。 |

### 1.3 本次交付边界（重要）

- **本次交付**：**Phase 0（状态一致性，完整）** + **Phase 1（Heuristic 完整化，核心）**。
- **本次不交付（仅路线图列出）**：Phase 2（CP-SAT Shadow/Canary）、Phase 3（Canary 灰度激活）、Phase 4（Command Map Decision Cockpit / 前端重构）、Phase 5（反馈学习闭环）。
- **原因**：用户明确要求"每个 Phase 独立提交可运行改动""先保证输入正确"；仓库已有相当基础，先以可验证的增量落地，避免一次性大爆炸改动。

### 1.4 关键现状结论（主理人侦察 + 架构师核验，必须纳入设计背景）

1. **P0-1 已实锤**：`world-state.service.ts:137-155` 直接从 ewohPersonnel/ewohDevice/ewohSpatialEntity/ewohRouteNode 等表独立构建资源视图，**未消费 ResourceProjectionService**（后者已有 version/sourceTs/freshness/dataQuality/UNKNOWN 坐标规范）。
2. **坐标**：`travel-cost.service.ts` 已有显式 degraded fallback（feasible=false + fallbackReason + dataQuality）；`resource-projection.service.ts:104` 已用 UNKNOWN(null) 拒绝 0,0；需排查 routing/world-state 是否还有 0,0 冒泡（已知 `routing.service.ts` 曾有 `from ?? {x:0,y:0}` 兜底，交付报告中已修复）。
3. **约束系统**：`constraints.ts` 已有完整约束类型系统（16 hard + 9 soft 支持清单）；`ewohSchedulingConstraint` 表存在；`plan.service.ts:303-307` 有按 planId+active 加载；`scheduler.service.ts:1067` override 写入；**需确认 run 主链路是否加载 + 补 integration test**。
4. **TaskRequirement**：`standalone_016_task_requirement` 已建 TaskRequirement 表；需确认调度内 derived fallback 是否显式标记。
5. **测试基础**：server 全量 jest，60+ scheduler spec 已存在（constraint-lifecycle/candidates/cp-sat-contract/event-driven 等）。

---

## 2. 用户故事

以工厂调度员 / 运维工程师 / 平台管理员视角：

| # | 角色 | 故事 | 期望收益 |
|---|---|---|---|
| US-1 | 调度员 | 作为调度员，我希望地图、调度器、派发看到同一份资源状态（人员/设备/工位/遥测/预占/班次），以便我基于真实状态决策，而不是被不一致的数据误导。 | 状态单一事实源，无口径分叉 |
| US-2 | 调度员 | 作为调度员，我希望我手工锁定的资源（LOCK/EXCLUDE/PREFER/BOOST 等）在自动重排、局部重排、重试后仍然生效，以便我的干预不被系统悄悄覆盖。 | 人工约束跨 run 不丢 |
| US-3 | 调度员 | 作为调度员，我希望看到每个任务为什么被分给这个人/设备/工位（优先级拆解、被拒候选、硬约束、软成本），以便信任系统并快速定位问题。 | 可解释调度 |
| US-4 | 调度员 | 作为调度员，我希望系统只在受影响范围内局部重排，以便不干扰无关任务、减少计划抖动（churn）。 | 局部重排、禁止全厂重排 |
| US-5 | 调度员 | 作为调度员，我希望在确认 override 前预览影响（受影响分配/新冲突/延迟/路程/负荷/工位等待/计划抖动），以便评估风险后再操作。 | Override Preview |
| US-6 | 调度员 | 作为调度员，我希望安全关键与交期紧迫任务优先被调度，且安全约束永不被绕过，以便满足生产计划与安全要求。 | 动态优先级 + safety 硬约束 |
| US-7 | 调度员 | 作为调度员，我希望不合格候选（技能不足/证书过期/离线/电量不足/工位能力不符）被明确拒绝并给出原因，以便我知道该补什么资源。 | Candidate 可解释拒绝 |
| US-8 | 运维 | 作为运维工程师，我希望任何调度运行可确定性重放（同一输入→同一输出），以便定位偶发问题、做回归对比。 | Deterministic replay |
| US-9 | 运维 | 作为运维工程师，我希望所有人工干预（override/approve/ack/resolve）都有 operator+reason+审计，以便合规追溯。 | 全干预审计 |
| US-10 | 运维 | 作为运维工程师，我希望前端断线重连后通过 SSE resync 自动恢复最新状态，以便不基于陈旧数据决策。 | SSE resync + polling fallback |
| US-11 | 管理员 | 作为多租户平台管理员，我希望不同组织的调度数据严格隔离（RLS），以便安全合规、无跨组织泄漏。 | 多租户隔离 |
| US-12 | 调度员 | 作为调度员，我希望派发采用"审批→事务预占→冲突校验→派发"的原子流程，以便杜绝重复占用/过期方案被派发。 | Reservation/Dispatch 事务化 |

---

## 3. 需求池

优先级定义：**P0 = Must have**（本次 Phase 0 完整交付）；**P1 = Should have**（本次 Phase 1 核心交付）；**P2 = Nice to have / 后续路线图**（Phase 2-5，仅列出不做细化）。

### 3.1 P0 — Phase 0 状态一致性（本次完整交付）

| ID | 需求 | 用户原文编号 |
|---|---|---|
| P0-1 | Resource State 单一事实源 | #1 |
| P0-2 | 持久化人工约束生命周期（跨 run 不丢） | #2 |
| P0-3 | 位置坐标统一（FACTORY_CARTESIAN / WGS84 / UNKNOWN） | #3 |
| P0-4 | TaskRequirement 权威化（业务字段落库，keyword 仅 legacy fallback） | #4 |
| P0-5 | 实时状态同步（SSE 统一事件枚举 + envelope + resync） | #10 |

### 3.2 P1 — Phase 1 Heuristic 完整化（本次核心交付）

| ID | 需求 | 用户原文编号 |
|---|---|---|
| P1-1 | 动态任务优先级（PriorityContext + effectivePriorityScore/breakdown） | #5 |
| P1-2 | Candidate Engine（Task×Person×Device×Station×时间窗 → CandidateEvaluation） | #6 |
| P1-3 | 硬约束与软目标严格分离 | #7 |
| P1-4 | Heuristic 完整化（station 决策变量/真实容量/queue/setup/changeover/魔法数入策略） | #8 |
| P1-5 | 冲突与局部重排（ConflictDetector/Reconciler/Query 分离 + 纯查询） | #11 |
| P1-6 | Reservation/Dispatch 事务化（proposal→approve→reservation→conflict check→dispatch） | #12 |
| P1-7 | 可解释调度（每个 Assignment 完整 DecisionTrace） | #13 |
| P1-8 | Human-in-the-loop（Override Preview 端点 + 全 override 审计） | #14 |

### 3.3 P2 — Phase 2-5 路线图（仅列出，不在本次交付范围）

| Phase | 内容 | 用户原文编号 |
|---|---|---|
| Phase 2 | **CP-SAT Shadow**：task→person/device/station/start time；no-overlap/容量/前序/窗口/frozen/manual 约束；目标含 weighted tardiness/travel/station waiting/workload/fatigue/energy/churn/setup；shadow 只比较不 dispatch；timeout 显式 fallback heuristic | #9 |
| Phase 3 | **CP-SAT Canary 灰度激活**：shadow 评估稳定后按流量/覆盖面灰度；solverStatus 如实标记；部署启用流程对齐 ADR-003 | #9 延续 |
| Phase 4 | **Command Map Decision Cockpit**：Scheduling Decision Cockpit（selectedRunId/selectedPlanId/selectedPlanVersion/comparisonPlanId/snapshotVersion，禁止 plans[0]）；唯一 Scheduling ViewModel（React Query normalized → CommandMapSchedulerViewModel → pure map layers）；CommandMap 代码拆分（Shell/Store/MapViewport/OverridePreviewPanel/PlanComparePanel） | #15 #16 #17 |
| Phase 5 | **反馈学习闭环**：planned vs actual 统计、离线 calibration、模型仅建议不取消安全约束 | #18 |

### 3.4 横切约束（贯穿本次交付，均须遵守）

| ID | 约束 | 用户原文编号 |
|---|---|---|
| X-1 | 数据库与契约：db/migrations/standalone_* 为事实源；新字段=新 migration+rollback+TS shared contract+OpenAPI+route audit+schema generation；RLS/org isolation 不破坏；审计 background/system context | #19 |
| X-2 | Python Edge 不成为第二调度写中心；共享契约防语义漂移 | #20 |
| X-3 | 代码质量：无 magic number、无 0,0、GET 无副作用、domain fact 与 derived 分离、solver 不直接读 DB（只收 immutable SolverRequest）、map 不执行业务逻辑、全 fallback 显式、全 replan 记 cause、全干预记 operator/reason、deterministic replay、不破坏现有 API | #21 |
| X-4 | 测试要求：unit + invariant + integration + replay determinism + performance（10/100/500/1000 tasks） | #22 |
| X-5 | 验收指标：hard violation=0、reservation overlap=0、跨组织泄漏=0、无 0,0、active constraints 不丢、plan 可重放、fallbackReason 明确、shadow 不可 dispatch、SSE resync、override 全审计、safety 边界不动 | #23 |

---

## 4. 功能规格要点

> 每项含功能描述与验收标准（Acceptance Criteria，AC）。编号引用用户原文编号。

### 4.1 P0-1 Resource State 单一事实源（#1）

**功能描述**
- 以 `ResourceProjectionService` 为唯一 Resource State 事实源，聚合 Personnel / Device / Station / Telemetry / Reservation / Shift，输出唯一 ResourceState。
- WorldStateSnapshot / Command Map（resources/state）/ Scheduler / Dispatch 统一消费该投影，禁止各自从底层表独立拼装资源视图（修复 world-state.service.ts:137-155 的旁路）。
- ResourceState 必须携带：`version`、`sourceTs`、`freshness`（FRESH/STALE/UNKNOWN）、`dataQuality`；设备/人员/工位位置与能力字段可追溯（有背衬列才填充，未知显式 null/UNKNOWN）。
- `GET /api/scheduler/resources/state` 补齐：workload / certificationExpiry / locationConfidence / locationUpdatedAt / telemetryUpdatedAt / capacity / queue。

**验收标准**
- AC-P0-1-1：resources/state 与 world-state 对同一设备/人员/工位的 capabilities、位置、容量完全一致（单测断言双源一致性）。
- AC-P0-1-2：ResourceState 每条记录含 version/sourceTs/freshness/dataQuality，字段级 locationUpdatedAt/locationConfidence/telemetryUpdatedAt 可见。
- AC-P0-1-3：world-state.service.ts 不再直接从 ewohPersonnel/ewohDevice/ewohSpatialEntity/ewohRouteNode 独立拼装资源视图（或改为消费 ResourceProjectionService）。
- AC-P0-1-4：Command Map / Scheduler / Dispatch 消费同一投影；无 0,0 冒泡（见 P0-3）。
- AC-P0-1-5：新增集成测试：跨服务读取同一资源状态一致；多租户 org 过滤不破坏（X-1）。

### 4.2 P0-2 持久化人工约束生命周期（#2）

**功能描述**
- LOCK / EXCLUDE / PREFER / BOOST / ADJUST_TIME / CHANGE_RESOURCE 等 active 状态约束必须持久化（ewohSchedulingConstraint，含 operator/reason/有效期/审计）。
- **关键**：在 manual run、automatic run、state-triggered replan、partial replan、retry、plan regeneration 全部路径中重新加载 active constraints，**不得因空 constraints 丢失锁定**。
- 新增 integration test 覆盖"约束跨 run 不丢"。

**验收标准**
- AC-P0-2-1：任一调度路径（manual/automatic/state-triggered/partial/retry/regeneration）加载的 active constraints 与 DB 一致；无路径因空 constraints 丢失 LOCK/EXCLUDE。
- AC-P0-2-2：integration test：创建 LOCK → 触发重排 → 断言约束仍生效；EXCLUDE 同理。
- AC-P0-2-3：override 写入（scheduler.service.ts:1067 现有逻辑）保留；每条约束有 operator/reason/有效期；审计可查。
- AC-P0-2-4：失效/过期约束不参与求解，且 deactivate 可审计。

### 4.3 P0-3 位置坐标统一（#3）

**功能描述**
- 坐标类型统一为 `FACTORY_CARTESIAN {x, y, floorId}` / `WGS84 {lat, lng}` / `UNKNOWN`。
- 禁止：经纬度当笛卡尔使用、缺失坐标填 (0,0)。
- 排查 routing / world-state / route-cost 全链路，确保无 0,0 冒泡；坐标缺失显式 UNKNOWN/null + feasible=false + fallbackReason。

**验收标准**
- AC-P0-3-1：代码库 grep 无 `{x:0,y:0}` / `from ?? {x:0,y:0}` 类兜底（routing.service.ts 已修复项保持回归测试）。
- AC-P0-3-2：坐标缺失时 ResourceState / Snapshot / RouteCost 显式 UNKNOWN(null)，travel-cost 返回 feasible=false + fallbackReason（no_route_edge / coords_unknown / graph_unavailable）+ dataQuality。
- AC-P0-3-3：FACTORY_CARTESIAN 与 WGS84 不混用；涉及 WGS84 的路径有显式类型区分。
- AC-P0-3-4：单测覆盖：无坐标任务不产生 (0,0) 伪坐标；经纬度不进入笛卡尔距离计算。

### 4.4 P0-4 TaskRequirement 权威化（#4）

**功能描述**
- TaskRequirement 字段（requiredSkills / skillMatchMode / requiredCertifications / requiredDeviceCapabilities / candidateStationIds / requiredResourceQuantities / safetyCritical / preemptible / earliestStart / latestStart / dueAt / plannedDuration / productionImpact / downstreamImpact / forbiddenZones / minimumDeviceBattery）成为**业务事实**（读正式字段/表，standalone_016_task_requirement 已建）。
- keyword heuristic（taskType/priority 白名单派生）仅作 **legacy fallback**，且必须显式标记 `derived`。

**验收标准**
- AC-P0-4-1：TaskRequirement 有值时调度读正式字段；无值时 keyword fallback 输出带 derived 标记，不冒充业务事实。
- AC-P0-4-2：安全关键任务（safetyCritical）判定来自正式字段，非 taskType 白名单猜测；safety 硬约束不可绕过。
- AC-P0-4-3：requiredDeviceCapabilities / candidateStationIds / minimumDeviceBattery / forbiddenZones 进入候选与求解输入。
- AC-P0-4-4：现有 world-state-derive 测试适配后全绿；新增断言"有列读列、无列 derived 标记"。

### 4.5 P0-5 实时状态同步（#10）

**功能描述**
- 复用现有 SSE（scheduler-stream / outbox），统一事件枚举：`world.entity.updated` / `resource.state.changed` / … / `replan.completed`（完整枚举以契约清单为准，见待确认 Q4）。
- 统一 envelope：`eventId / sequence / orgId / snapshotVersion / entityVersion / type / occurredAt / payload`。
- 保留 Last-Event-ID / gap resync / polling fallback；SSE 断线→轮询退路→恢复切回。

**验收标准**
- AC-P0-5-1：SSE 事件全部携带统一 envelope；sequence 单调；envelope 含 snapshotVersion/occurredAt/orgId。
- AC-P0-5-2：断线重连 + Last-Event-ID 无缺口增量推送；有缺口触发 resync（前端全量重拉权威状态）。
- AC-P0-5-3：事件枚举有契约（contracts/events 或 openapi），无 undocumented 事件。
- AC-P0-5-4：单测覆盖 envelope 字段与 gap resync；SSE 不可用时 polling fallback 正常。
- AC-P0-5-5：多租户下事件 orgId 正确，无跨 org 事件泄漏（X-1）。

### 4.6 P1-1 动态任务优先级（#5）

**功能描述**
- `PriorityContext` 综合：basePriority / deadline slack / waiting age / production impact / downstream impact / event severity / blocked production / manual boost。
- safety 保持 hard（Safety Block 硬约束不可被优先级绕过）。
- 输出：`effectivePriorityScore` / `scoreBreakdown` / `priorityReasons` / `policyVersion`；确定性可重放。

**验收标准**
- AC-P1-1-1：PriorityContext 各因子进入计算且 breakdown 可解释；manual boost 生效且有 operator/reason 审计。
- AC-P1-1-2：safetyCritical 任务不受优先级排序影响其硬约束安全性（SAFETY_CRITICAL_LOCKED 语义保持）。
- AC-P1-1-3：同一输入两次计算输出完全一致（deterministic）；policyVersion 记录在输出中。
- AC-P1-1-4：event severity 分支不再是死路径（现状核验指出该分支为死代码）。

### 4.7 P1-2 Candidate Engine（#6）

**功能描述**
- 构建 Task × Person × Device × Station × 时间窗 的 CandidateEvaluation，含 `rejectReasons` 与 `scoreBreakdown`。
- **hard 不满足不进 solver feasible set，但必须可解释**（拒绝原因可见）。
- 新增 `GET /api/scheduler/tasks/:taskId/candidates`（是否本次新增见待确认 Q2）。

**验收标准**
- AC-P1-2-1：候选评估覆盖 Person/Device/Station/时间窗四维；拒绝候选带明确 rejectReasons（技能/证书/健康/可用性/capability/battery/station 能力与容量/reservation no-overlap/forbidden zone/时间窗等）。
- AC-P1-2-2：hard 不满足的候选不进入 solver feasible set；可解释层仍可查询其拒绝原因。
- AC-P1-2-3：新端点（若本次交付）返回 eligible/rejected/score breakdown/route ETA，无副作用（GET 纯查询）。
- AC-P1-2-4：单测：技能不匹配/证书过期/离线/低电量/工位容量不足各场景 rejectReasons 正确。

### 4.8 P1-3 硬约束与软目标严格分离（#7）

**功能描述**
- 硬约束（必须满足，违反=不可行）：技能 / 证书 / 健康 / 可用性 / capability / battery / station 能力与容量 / reservation no-overlap / forbidden zone / predecessor / 时间窗 / executing / frozen / LOCK / EXCLUDE。
- 软目标（优化方向，不违反硬约束）：tardiness / travel / queue / wait / workload imbalance / fatigue / energy / setup / changeover / churn / preferred / production impact。

**验收标准**
- AC-P1-3-1：约束类型系统（constraints.ts 16 hard + 9 soft）与实现一一对应；hard 违反=infeasible（可解释），soft 仅影响 score。
- AC-P1-3-2：solver 输出可区分 hard violation（无）与 soft cost 明细（scoreBreakdown）。
- AC-P1-3-3：invariant 测试：任何输出方案无 hard violation（不重叠/容量/证书/依赖/frozen/safety）。

### 4.9 P1-4 Heuristic 完整化（#8，Phase 1 核心）

**功能描述**
- 枚举 `candidateStationIds`；**station 为决策变量**（而非仅 person/device）。
- 真实 station capacity / queue；setup / changeover cost 进入目标。
- **魔法数移入 SchedulingPolicy**（weights_json 版本化，对齐 ADR-001；不再 buildPolicy 硬编码派生）。
- 全 score 输出 DecisionTrace；确定性。

**验收标准**
- AC-P1-4-1：求解输出含 station 分配决策；station 分配满足容量硬约束且尊重 candidateStationIds。
- AC-P1-4-2：setup/changeover 成本参与评分且可解释（scoreBreakdown 可见）。
- AC-P1-4-3：求解器权重全部来自 SchedulingPolicy（weights_json），无魔法数派生；旧配置无 weights 时回退默认值（向后兼容）。
- AC-P1-4-4：每个 Assignment 输出 DecisionTrace（见 P1-7）；两次求解结构+objective 完全一致（deterministic fixtures）。
- AC-P1-4-5：性能基线：10/100/500/1000 tasks 可接受耗时（具体阈值见待确认 Q8），超时显式 fallback 且 fallbackReason 明确。

### 4.10 P1-5 冲突与局部重排（#11）

**功能描述**
- `ConflictDetector` / `ConflictReconciler` / `ConflictQueryService` 职责分离。
- `GET /conflicts` 纯查询无副作用（现状交付报告 P2 遗留项本次纳入 P1 修复：listConflicts 写副作用拆分，显式 reconcile 触发端点）。
- 事件 → ImpactAnalyzer → 受影响子图 → freeze → 局部 re-solve → compare → preview/auto/manual。
- **禁止全工厂重排**。

**验收标准**
- AC-P1-5-1：GET /conflicts 无任何写副作用（写操作走显式端点：acknowledge/resolve/suppress/reconcile）。
- AC-P1-5-2：冲突生命周期持久化（OPEN/ACKNOWLEDGED/RESOLVED/SUPPRESSED + detectedAt/acknowledgedBy/resolvedBy/suppressUntil/planId）且审计可查（基于 standalone_013）。
- AC-P1-5-3：局部重排仅覆盖受影响子图；无关任务 assignment 不变（churn 可控）；无"全工厂重排"路径。
- AC-P1-5-4：事件→ImpactAnalyzer→freeze→局部 re-solve→compare→preview/auto/manual 全链路集成测试（含 device offline→conflict→replan、route blocked、reservation 冲突场景）。
- AC-P1-5-5：executing/frozen/LOCK 任务在重排中不被意外改变。

### 4.11 P1-6 Reservation/Dispatch 事务化（#12）

**功能描述**
- solver 输出仅 **proposal**（不直接派发）。
- 派发链路：approve → transaction → snapshot/version validation → reservation → conflict check → dispatch。
- stale 拒绝并生成 STALE_PLAN / RESERVATION_CONFLICT 事件进入局部 replan。

**验收标准**
- AC-P1-6-1：approve 校验 plan.version + snapshotVersion 新鲜度；stale 拒绝（PLAN_STALE）且触发局部 replan（含 cause 记录）。
- AC-P1-6-2：reservation 与 dispatch 在同一事务语义内（DB EXCLUDE 背板 + CAS 幂等），无重复占用。
- AC-P1-6-3：并发 reservation 竞争测试通过（不重叠）；冲突时生成 RESERVATION_CONFLICT 事件。
- AC-P1-6-4：reservation overlap 验收指标=0（#23）。

### 4.12 P1-7 可解释调度（#13）

**功能描述**
- 每个 Assignment 保存 DecisionTrace：priority breakdown / rejected candidates / hard constraints / soft costs / route cost / workload / station contribution / baseline delta / solver name+version / policyVersion / snapshotVersion。

**验收标准**
- AC-P1-7-1：plan 详情/assignment 可查询完整 DecisionTrace（现有 DecisionTrace 持久化扩展至全字段）。
- AC-P1-7-2：trace 含 rejected candidates 与 hard/soft 明细；solver name+version、policyVersion、snapshotVersion 全部落库。
- AC-P1-7-3：前端可展示（VM 透传，不重算）。

### 4.13 P1-8 Human-in-the-loop（#14）

**功能描述**
- 保留 LOCK* / EXCLUDE / PREFER / BOOST / ADJUST_TIME / CHANGE_RESOURCE。
- 新增 `POST /api/scheduler/plans/:planId/overrides/preview`，返回：affectedAssignments / conflictsIntroduced / latenessDelta / travelDelta / workloadDelta / stationWaitDelta / planChurn。
- 所有 override 持久化 + 有效期 + operator + reason + 审计。

**验收标准**
- AC-P1-8-1：preview 端点返回 7 项 delta 指标；纯计算无副作用（不落库、不触发重排）。
- AC-P1-8-2：确认后 override 持久化（SchedulingConstraint）+ 有效期 + operator + reason + 审计；replan 继承。
- AC-P1-8-3：safetyCritical 任务不可被 override 改变分配或时间（SAFETY_CRITICAL_LOCKED 保持）。
- AC-P1-8-4：单测覆盖 9 类动作（lock/unlock/exclude/prefer/change resource/constrain time/manual boost 等）+ preview 指标计算。

---

## 5. UI/UX 变更说明

**本次不改 Command Map 主体**（Command Map 深度重构 / Decision Cockpit 属 Phase 4 路线图）。本次前端侧仅做**数据契约准备与兼容适配**：

| 变更点 | 说明 | 范围 |
|---|---|---|
| SSE 消费 | 前端统一消费 `/api/scheduler/resources/state` + `/active-plans` + `/snapshot`，本地仅 UI state（现有 useCommandMapSchedulerState 已具备，保持） | 兼容适配，不重构 |
| 事件 envelope | SSE envelope 新增字段（snapshotVersion/planId/occurredAt）前端类型同步 | shared/types 更新 |
| 字段扩展 | resources/state 新增 workload/certificationExpiry/locationConfidence 等字段，前端类型与展示安全处理（null/UNKNOWN） | 向后兼容 |
| 候选展示 | 若本次交付 GET /candidates，前端 candidateExplainVM 透传后端结果（不重算资格） | VM 透传 |
| Override Preview | 若本次交付 preview 端点，前端 OverridePanel 增加"预览后确认"流程入口 | 轻量接入 |

**禁止**：前端本地拼装资源状态、前端重算资格、plans[0] 隐式选择（plans[0] 问题随 Phase 4 一并根治，本次不扩大范围）。

---

## 6. 非功能需求

| 类别 | 要求 |
|---|---|
| **确定性** | 同一输入（snapshot+policy+constraints+weights+solverVersion）两次求解结构+objective 完全一致；Priority/Candidate/Heuristic/CP-SAT mapping 均可重放；固定 fixtures 集（现有 14 场景延续）。 |
| **性能** | 调度运行耗时在 10/100/500/1000 tasks 下可接受（具体阈值待确认 Q8）；求解超时显式 fallback（solverStatus/fallbackReason 如实标记，绝不冒充）；SSE 轮询批量有节流。 |
| **安全** | safetyCritical 硬约束永不可绕过；safety 边界（SAFETY_BLOCK 熔断）不动；RLS/org isolation 不破坏（跨组织泄漏=0）；Python Edge 不成为第二写中心。 |
| **可审计** | 全干预（override/approve/ack/resolve/suppress/activate）记 operator+reason；全 replan 记 cause；审计区分 background/system context（X-1）；GET 无副作用。 |
| **契约与兼容** | 不破坏现有 API；新字段=migration+rollback+TS shared contract+OpenAPI+route audit+schema generation；旧配置/旧请求体向后兼容。 |
| **可观测** | metrics 覆盖 candidate/hard_reject/affected/churn/fallback/SSE resync 等（现有基础延续）；全链路 id 串联（run→snapshot→plan→assignment→feedback）。 |

---

## 7. 待确认问题清单（Open Questions）

| # | 问题 | 影响 | 建议/倾向 |
|---|---|---|---|
| Q1 | CP-SAT 是否继续保持实验性（shadow 只比较不 dispatch）？Phase 2 是否在本仓库后续排期即启动？ | 影响 Phase 2 边界与优先级 | 保持实验性；shadow 不可 dispatch（#9/#23 明确）；待 Phase 1 验收后另行排期 |
| Q2 | 本次（Phase 0/1）是否新增 `GET /api/scheduler/tasks/:taskId/candidates` 端点？ | 影响 P1-2 交付范围与 OpenAPI | 建议新增（需求 #6 明确要求该端点；成本低、可解释价值高）；若担心范围可降级为现有候选 API 增强 |
| Q3 | migration 命名规范：本次新 migration 从 `standalone_017` 起？命名规则是否沿用 `standalone_XXX_<snake_case>` + rollback + verify 三件套？ | 影响 X-1 落地 | 沿用现有规范（012-016 先例）；新字段=新 migration，禁止改旧 migration |
| Q4 | SSE 统一事件枚举的**完整清单**是什么？（已知 world.entity.updated / resource.state.changed / replan.completed / conflict.* / plan.* / assignment.* / execution.deviation 等） | 影响 P0-5 契约 | 以 contracts/events 补齐 + openapi 登记为事实源；请架构师/工程师出事件目录草案 |
| Q5 | Phase 3（Canary 灰度激活）的具体范围与判定标准（shadow 评估通过阈值、灰度流量比例）？ | 影响路线图表述 | 本次仅占位：shadow 评估一轮通过 + 人工 activate（ADR-003 启用流程）后进入 canary；细则 Phase 2 前定 |
| Q6 | TaskRequirement 权威化后，keyword heuristic fallback 的**标记格式**（derived[] 数组？字段级 derived 标志？）与下游消费约定？ | 影响 P0-4 数据契约 | 倾向字段级 `derived: true` 标记 + 快照统一 derived[] 汇总；与现有 world-state 派生标记保持一致 |
| Q7 | Override Preview 在**大 plan 场景**是否需要异步计算（preview job + 轮询结果）？同步计算的规模上限？ | 影响 P1-8 设计 | 优先同步（预览即算，不落库）；若 1000+ tasks 超时再引入异步；请工程师评估 |
| Q8 | 性能基线：10/100/500/1000 tasks 的目标耗时阈值？ | 影响 P1-4/X-4 | 倾向：10/100 tasks 秒级内、500 tasks < 5s、1000 tasks < 10s（求解，不含 IO）；请工程师给出可执行基准 |
| Q9 | 现有 `constraints.ts` 16 hard + 9 soft 与需求 #7 清单（17 硬 + 13 软）差异（STATION_CAPACITY 类型缺失等）如何补齐？ | 影响 P1-3 | 以需求 #7 清单为权威，补齐缺失约束类型；软目标与现有 8 权重 objective 对齐 |
| Q10 | plan.yaml 状态机契约漂移（shadow/simulating/pending_review vs 实现 shadow/approved/dispatched/executing）是否本次处理？ | 影响 X-1 契约一致性 | 建议本次顺带对齐（低风险）；若范围敏感可列入 P2 |

---

## 附：需求原文编号 ↔ 本 PRD 章节映射

| 用户原文 # | 需求标题 | PRD 章节 |
|---|---|---|
| 1 | Resource State 单一事实源 | 4.1 (P0-1) |
| 2 | 持久化人工约束生命周期 | 4.2 (P0-2) |
| 3 | 位置坐标统一 | 4.3 (P0-3) |
| 4 | TaskRequirement 权威化 | 4.4 (P0-4) |
| 5 | 动态任务优先级 | 4.6 (P1-1) |
| 6 | Candidate Engine | 4.7 (P1-2) |
| 7 | 硬约束与软目标严格分离 | 4.8 (P1-3) |
| 8 | Heuristic 完整化 | 4.9 (P1-4) |
| 9 | CP-SAT Shadow | 3.3 (Phase 2/3) |
| 10 | 实时状态同步 | 4.5 (P0-5) |
| 11 | 冲突与局部重排 | 4.10 (P1-5) |
| 12 | Reservation/Dispatch | 4.11 (P1-6) |
| 13 | 可解释调度 | 4.12 (P1-7) |
| 14 | Human-in-the-loop | 4.13 (P1-8) |
| 15-17 | Command Map 前端/Cockpit | 3.3 (Phase 4) + 5 |
| 18 | 反馈学习闭环 | 3.3 (Phase 5) |
| 19 | 数据库与契约 | 3.4 (X-1) |
| 20 | Python Edge | 3.4 (X-2) |
| 21 | 代码质量 | 3.4 (X-3) |
| 22 | 测试要求 | 3.4 (X-4) |
| 23 | 验收指标 | 3.4 (X-5) + §6 |
