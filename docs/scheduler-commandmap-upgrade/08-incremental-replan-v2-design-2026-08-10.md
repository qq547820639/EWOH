# 08 Incremental Replan V2 增量设计 — Command Map 智能调度升级（全自动迭代执行）

> 文档编号：ARC-EWOH-CM-2026-08-10-08
> 日期：2026-08-10 ｜ 架构师：高见远（software-architect）｜ 主理人：齐活林（team-lead）
> 基线：HEAD=d48d6cc（+ 基线恢复 c162a48 之后实现）
> 依据：用户全自动迭代提示词（Incremental Replan V2 / ReplanImpact / 冻结策略 / Impact Propagation / Churn Objective V2 / Replan Preview / Storm 治理 / Decision Cockpit / Prediction Shadow）+ 既有 05-incremental-design
> 状态：设计已定稿，M01-M05 按本设计实现

设计基线：HEAD=d48d6cc。约束遵守：NestJS 生产调度唯一写权限不变（所有写仍经 ReplanCoordinatorService/PlanService 在 buildGucSettings(ctx) 事务内）；Python Edge（src/edge_platform/）保持 advisory-only 不动；全部新增为可选字段/可选配置，默认行为=现状，无必要 DB migration；租户隔离保持（影响分析按 org 快照、风暴计数按 org、KPI 按 org）。改动最小、易测试、易回滚（回滚=恢复配置默认）。

================================================
1. ReplanImpact 领域模型
================================================
在 shared/scheduler.ts（SchedulingEventImpact 附近）新增（全可选字段，向后兼容；现有 ImpactAnalysis 不动）：

interface ReplanImpact {
  triggerType: SchedulingTrigger | string;
  triggerIds: string[];            // 触发实体 id（事件/资源/route edge/zone）
  affectedTaskIds: string[];       // 直接受影响 + 传播闭包后需重排的任务（=现有 ImpactAnalyzer.affectedTaskIds 语义超集）
  affectedResourceIds: string[];   // 受影响资源（person/device/station 统一 id，投影层同 id 空间）
  affectedPersonIds: string[];
  affectedDeviceIds: string[];
  affectedStationIds: string[];
  affectedZoneIds: string[];
  frozenAssignmentIds: string[];   // 冻结 assignment/task id（executing/dispatched/in_progress/LOCK/safety）
  movableAssignmentIds: string[];  // 可移动任务（= affected - frozen）
  reasons: string[];               // 逐条原因（与 triggerIds 对齐，如 'DEVICE_OFFLINE:D-1'）
  snapshotVersion: string;         // 影响分析所基于的世界快照
  baselinePlanVersion: number | null; // 当前生效方案 version（无则 null）
}

兼容方式：ReplanCoordinatorService 现有 impactAnalysis():ImpactAnalysis 保留（25-29 行）；新增 analyzeImpactV2() 返回 ReplanImpact，handleTrigger 内部改消费 V2；run.payload / plan.baselineDelta 序列化 ReplanImpact 摘要（不建表）。命名贴合现有风格（affectedTaskIds/frozenTaskIds 沿用 impact-analyzer.ts:28-41，frozen 语义沿用 FROZEN_STATUSES=130）。

================================================
2. 冻结策略
================================================
默认冻结（任何一条命中即冻结，沿用现有实现并形式化）：
- executing/dispatched/in_progress（impact-analyzer.ts:130 FROZEN_STATUSES；world-state.service.ts:463-472 lockedAssignments 同源）
- 人工 LOCK：LOCKED_PERSON/DEVICE/STATION/TIME/ASSIGNMENT 约束（heuristic 169-184 / cp-sat 296-316 已拆解；snapshot.lockedAssignments 已含）
- safety frozen：SAFETY_EVENT / ZONE_RESTRICTED 影响类 → canAutoReplan=false（impact-analyzer.ts:108-121）；safetyBlockedPersonIds/DeviceIds + safety forbiddenZones（world-state 483-535）进入硬过滤，fail-closed
- 不可安全移动生命周期阶段：!TaskLifecycle.isSchedulable(status)（task-lifecycle.ts）

movable/affected 判定规则：
- affected = 直接命中（设备/人员/工位/区域/边匹配）∪ 下游传递闭包（predecessor 反向传播，impact-analyzer.ts:202-215 已有）∪ 资源维度命中（见 §3）
- movable = affected ∩ schedulable ∩ !frozen，且"移动收益 > 阈值"：以 ReplanPreview 的 objective 对比判定（churn 成本 < 目标收益时保留原 assignment 不变即不动）；预览中保持不变的任务自动归入 unchangedAssignmentCount，不进求解子图
- 核心不变量（写入测试）：没有影响理由的 assignment 绝不进入重排集合。实现即 replan-coordinator.ts:101-106 的 partialSnapshot 过滤（affected ∪ frozen），新增单测断言"无关任务不在 solver 输入中"。

================================================
3. Impact Propagation（确定性传播）
================================================
新增纯函数文件 server/modules/scheduler/impact-propagation.ts：propagateImpact(snapshot, seed: ReplanImpact) → ReplanImpact（闭包扩散）。传播链示例：
- DEVICE_OFFLINE/D-1 → affectedDeviceIds={D-1} → tasks.deviceId=D-1 入 affectedTaskIds → deviceBinding(D-1→P-1)（world-state 476-481）→ affectedPersonIds={P-1} → P-1 的 assignee 任务入 affected → 设备空间实体 parentId 解析 zone（world-state 555-560）→ affectedZoneIds → 该 zone 上未锁定任务入 affected
- PERSON_UNAVAILABLE/P-1 → affectedPersonIds → assigneeId=P-1 任务 → predecessor 闭包下游
- STATION_BLOCKED/S-1 → affectedStationIds → tasks.stationId=S-1 → 空间 parent 解析 zone
- ROUTE_BLOCKED/edge-E1 → routeEdgeTaskIndex['E1']（world-state 434-457 已建）→ affectedTaskIds
- SAFETY_BLOCK → safetyBlockedPersonIds/DeviceIds/forbiddenZones（world-state 483-535）→ fail-closed：受影响任务不得用 blocked 资源（求解器已消费 safetyBlockedPersonIds，cp-sat:350-351 / heuristic:570）
停止条件与防无限扩散：
- maxPropagationDepth=3（仅 predecessor 闭包计入深度；资源维度为 1 跳）+ maxAffectedTasks=200（可配置，入 SchedulingPolicyConfig.replan）
- 去重：(taskId, reasonCode) 集合；frozen 任务不入 movable 扩散（但可作 frozenPredEnd 已知结束时间，heuristic 225-234）
- 确定性：seed.triggerIds 排序 + BFS 按 taskId 字典序遍历 → 同 snapshot+trigger 恒同 ReplanImpact（单测：同输入两次传播结果 deep-equal）

================================================
4. Churn Objective V2
================================================
现有 objective 架构：policy.weights 8 权重（lateness/travel/wait/workload/station/change/risk/energy，shared/scheduler.ts:948-957），SchedulingObjectiveEvaluator.evaluate（service:57-171）统一计算，churn 目前并入 change 项（changeCost=baselineAssignee≠person 时 1，evaluator:117-120）。
融合方案（不新增权重维度，扩展 change 项内部）——SchedulingPolicyConfig 新增可选块（默认缺省=现状，无行为变化）：
  churn?: {
    personChangePenalty: number;      // 缺省 = weights.change
    deviceChangePenalty: number;      // 缺省 0（沿用现状：仅 person 变更计 churn）
    stationChangePenalty: number;     // 缺省 0
    startTimeShiftPenalty: number;    // 缺省 0（每 1min 起点位移罚分）
    sequenceChangePenalty: number;    // 缺省 0（相对基线执行顺序变化罚）
    assignmentRemovalPenalty: number; // 缺省 = weights.change
    assignmentAdditionPenalty: number;// 缺省 0
  };
消费点：SchedulingObjectiveEvaluator（EvaluatePlanInput 增加可选 config，从 policyService.getConfig() 传入；无则用缺省）；候选评分 computeScore（candidate-engine.service.ts:514-543）与 heuristic computeCandidateScore（heuristic:900-932）同步扩展；cp-sat buildRequest weights 透传不变（worker 侧 churn 项保持现状，服务端评估器为准）。魔法数禁止散落：所有默认值集中在 scheduling-policy.service.ts DEFAULT_CONFIG（:49-76 同风格）。测试：默认配置下 objective 与现状逐位一致（回归快照）。

================================================
5. Replan Preview / Diff 契约
================================================
复用 P4-COMPARE（PlanCompareService.compare，plan-compare.service.ts:22-140，changeTypes 14 类 + before/after/reasons 已在 PlanAssignmentDiff）与 OverridePreview readonly 模式（override-preview.service.ts）。新增 shared 契约：

  interface ReplanPreviewResult {
    baselinePlanId: string | null;
    candidatePlanId: string | null;   // PREVIEW-*，不持久化（同 override preview）
    readonly: true;
    affectedTaskCount: number;
    unchangedAssignmentCount: number;
    changedAssignmentCount: number;
    addedAssignmentCount: number;
    removedAssignmentCount: number;
    latenessDelta: number; travelDelta: number; workloadDelta: number;
    stationWaitDelta: number; changeoverDelta: number;
    energyRiskDelta: number; riskDelta: number; churnDelta: number;
    changedAssignments: PlanAssignmentDiff[];   // 复用，changeReasons=diff.reasons + ReplanImpact.reasons
  }
实现：新 ReplanPreviewService = ReplanCoordinatorService dry-run（buildSnapshot→analyzeImpactV2→partialSnapshot→solve）→ PlanCompareService.compare(基线方案, 候选) → 计数 + 指标增量（metrics 用 SchedulingObjectiveEvaluator 输出差值）；只读不落库不派工（同 OverridePreviewService 语义）。

================================================
6. 自动 Replan 与人工审批政策
================================================
判定维度（任一命中 → HUMAN_APPROVAL_REQUIRED，不自动落库，产出 ReplanPreview + 发 `replan.approval_required` SSE 事件）：
- 影响分类 critical_event（SAFETY_EVENT/ZONE_RESTRICTED；impact-analyzer.ts:108-121 已 canAutoReplan=false）
- affectedRatio = affectedTaskIds / 可调度任务数 > 阈值（缺省 0.5）
- 影响集合含 safetyCritical 任务（task.safetyCritical，world-state 329）
- 预期 churnDelta/affected > 阈值（缺省 0.4）
- latenessDelta > 0 或 riskDelta > 0（预览保守原则）
- 影响集合含人工 LOCK（snapshot.lockedAssignments 或 LOCKED_* 约束命中）
AUTO_REPLAN：soft_deviation / hard_conflict 且上述均不命中 → 直接走现有 handleTrigger 落库 proposed + SSE（唯一写权限不变）。
配置：SchedulingPolicyConfig 新增可选 replanApproval?: { autoMaxAffectedRatio, autoMaxChurnRatio, requireApprovalOnSafetyCritical, requireApprovalOnHumanLock }。

================================================
7. Replan Storm 治理
================================================
SchedulingPolicyConfig 新增可选 replan?: { replanDebounceMs=5000, minimumReplanIntervalMs=30000, maximumReplansPerWindow=12, conflictAggregationWindowMs=60000 }（与现有 triggerCooldownMs=30s 对齐，scheduling-policy.service.ts:61）。
放置：ReplanCoordinatorService 持有按 org 的有界 LRU 风暴计数（内存，无表）；TriggerService.evaluate 沿用 cooldown（trigger.service.ts）。conflict→impact batch：ConflictService.derive()（conflict.service.ts:82）产出的 open 冲突在 conflictAggregationWindowMs 内聚合为一个 ReplanImpact seed（triggerType=RESERVATION_CONFLICT + 并集 taskIds），替换 dispatchStateTriggers 的逐边/逐冲突 handleTrigger 循环（replan-coordinator.ts:185-232），一次求解处理一批。被抑制的触发计入 replanSuppressedCount KPI；SSE 发 `replan.suppressed`。

================================================
8. 新增 KPI
================================================
在 SchedulerKpiSnapshot.stability（shared/scheduler.ts:1553-1559）追加可选字段，聚合于 scheduler-metrics.service.ts（现有 recordPlanChurn/recordPartialReplanAffected/recordRun 模式，:35-190）与 kpi.service.ts：
- affectedAssignmentRatio = Σ affectedTaskIds / Σ 可调度任务（按 run，窗口均值）
- unchangedAssignmentRate = 1 − assignmentChurnRate（或 Σ unchanged / Σ baseline assignments）
- scheduleChurn = Σ (changed+added+removed) assignments / 窗口（recordPlanChurn 已累计，扩展粒度）
- replanDuration = run.solveDurationMs + persist 耗时（recordRun.durationMs 已含 solve；persist 另计）
- replanTriggerCount = 非 MANUAL 触发创建的 run 数 / 窗口
- replanSuppressedCount = 风暴守卫抑制数 / 窗口
全部可选字段，无 migration；数据源 = ewohSchedulingRun/ewohSchedulingFeedback + 内存计数器。

================================================
9. 任务分解（5 个里程碑，文件级子步骤；依赖 M01→M02→M03，M02→M04，M01→M05；每里程碑≥3 文件）
================================================
M01 数据契约与基础设施（新增：shared/scheduler.ts 扩展、impact-propagation.ts、tests）：
  新增 shared/scheduler.ts 字段：ReplanImpact、SchedulingPolicyConfig.replan/replanApproval/churn、ReplanPreviewResult、SchedulerKpiSnapshot.stability 扩展、PredictionShadowSample/Aggregate（§11）
  新增 server/modules/scheduler/impact-propagation.ts（纯函数 propagateImpact）
  新增 server/modules/scheduler/__tests__/impact-propagation.spec.ts（确定性+停止条件+核心不变量）
M02 服务端 Replan V2 内核（修改：replan-coordinator.service.ts、impact-analyzer.ts、conflict.service.ts、scheduling-policy.service.ts；新增测试）：
  replan-coordinator.service.ts：analyzeImpactV2、风暴守卫（debounce/interval/window/抑制计数）、conflict batch seed、候选求解接 CandidateEngine（修 #17）
  impact-analyzer.ts：返回形状扩展为 ReplanImpact（保留旧方法）
  conflict.service.ts：derive() 增加 conflictAggregationWindow 聚合入口
  scheduling-policy.service.ts：DEFAULT_CONFIG 增加 replan/replanApproval/churn 缺省
  __tests__/replan-v2-impact.spec.ts + __tests__/replan-storm.spec.ts + candidate-engine parity 测试
M03 预览与审批链路（新增：replan-preview.service.ts；修改：plan-compare.service.ts、plan.service.ts、scheduler.controller.ts、scheduler.service.ts；新增测试）：
  replan-preview.service.ts（dry-run + PlanCompareService.compare + 指标增量；只读）
  plan-compare.service.ts：补充 changeoverDelta/energyRiskDelta/riskDelta 派生
  plan.service.ts：approvePlan 前 consult replanApproval（沿用 assertNoSafetyCriticalChange:769 风格）
  scheduler.controller.ts：POST /replan/preview、审批事件；scheduler.service.ts 编排 AUTO_REPLAN/HUMAN_APPROVAL
  __tests__/replan-preview.service.spec.ts + override-preview.spec.ts 扩展
M04 Churn Objective + KPI（修改：scheduling-objective-evaluator.service.ts、candidate-engine.service.ts、heuristic-scheduling-solver.ts、scheduler-metrics.service.ts、kpi.service.ts；新增测试）：
  评估器/候选评分消费 churn 配置（缺省=现状回归）
  metrics/KPI 新增 6 项聚合
  __tests__/scheduling-objective-evaluator.service.spec.ts（默认=现状快照）+ __tests__/replan-kpi.spec.ts
M05 Decision Cockpit + Prediction Shadow Learning（新增客户端面板 + 服务端 shadow 评估；修改：CommandMap/FactoryMap/SchedulePanel strangler、prediction 模块）：
  客户端：TaskIntelligencePanel.tsx、RejectedCandidateExplain.tsx、layers/changed-by-replan + human-locked、PlanComparePanel 接 ReplanPreview；CommandMap.tsx/FactoryMap.tsx/SchedulePanel.tsx 渐进拆分（strangler，行为不变，复用现有快照测试 test/browser/snapshots）
  服务端：prediction/shadow-evaluator.service.ts（新增）、prediction shadow 指标聚合、canary 配置
  __tests__：shadow-evaluator.spec.ts、client 面板纯逻辑测试

================================================
10. Command Map Decision Cockpit 增量设计
================================================
- Task Intelligence 面板：新增 client/src/pages/CommandMap/panels/TaskIntelligencePanel.tsx，消费 GET /tasks/:taskId/candidates（TaskCandidatesResponse，shared/scheduler.ts:1341-1353）与 assignment.decisionTrace（SchedulingAssignment:758）；展示动态优先级 factor、stationOptions、rejectedHard。
- Rejected Candidate Explainability：**只消费服务端 DecisionTrace**（heuristic 已产出 rejectedHard/hardConstraints/softCosts/weightsSnapshot，heuristic:788-821；cp-sat-contract.spec.ts:143 已保证非占位）；前端只渲染不重算 hard constraints——规则写入面板注释 + 单测断言"无任何 hard 判定逻辑 import"（禁止前端引入 EligibilityService 语义）。
- 地图图层：SchedulerLayers.tsx 增加 changed-by-replan（ReplanPreviewResult.changedAssignments→taskId 集合）与 human-locked（snapshot.lockedAssignments + LOCKED_* 约束）两个 overlay；entityColors.ts 扩展调色板。
- What-if/Override Preview：OverridePreviewService 已存在（override-preview.service.ts）；V2 增加"重排 what-if"端点走 ReplanPreviewService，OverridePanel 复用同交互模式。
- Plan Compare：PlanComparePanel.tsx（已存在）接入 ReplanPreviewResult + ReplanImpact 摘要抽屉。
- Strangler 拆分：CommandMap.tsx(1159 行)→ 面板已分离，继续抽出 viewport/overlay/realtime 状态到 hooks（map-mode-machine.ts/replayContext.ts 已示范）；FactoryMap.tsx(1227)→ 抽 renderer/layer 组件；SchedulePanel.tsx(966)→ 抽方案列表/表格组件。每次抽取后跑 browser snapshot 防回归。

================================================
11. Prediction Shadow Learning 增量设计
================================================
- 数据契约（shared/scheduler.ts 新增，可选）：PredictionShadowSample { modelVersion, predictionType, inputVersion, prediction, baseline, confidence, createdAt, actual, absoluteError, relativeError }；PredictionShadowAggregate { mae, rmse, p50, p95, calibration, fallbackRate, coverage }。
- Shadow 评估：新增 prediction/shadow-evaluator.service.ts——基于现有 PredictionProvider（prediction-provider.ts:47-58）在 shadow 采样下记录预测 vs 确定性 baseline，待 ExecutionService/SchedulingFeedback 回填 actual（scheduling-feedback.service.ts）后计算 error 聚合；advisory-only，不写生产调度。
- Fallback 规则：沿用 resolvePrediction（prediction-provider.ts:131-145）：provider 不可用或 confidence < confidenceThreshold → deterministic baseline；生产求解路径保持现状（不接预测，见审计 #16）。
- Canary 阶梯：SchedulingPolicyConfig 新增可选 prediction?: { canaryFractions: [0,0.05,0.2,0.5,1], autoRollbackOn: { maxAbsoluteError, maxFallbackRate, minCoverage } }。canary 仅控制 shadow 采样比例，生产预测输出仍为 baseline；当窗口聚合 error/fallback/coverage 超阈值 → 自动回退 canary 至 0%（SSE 发 prediction.rollback + KPI）。
- 存储：无 migration——shadow 样本存内存环形缓冲 + 落 feedback 表既有列（或 baselineDelta JSON），KPI 聚合走 kpi.service。

================================================
横切约束（Shared Knowledge 摘要）
- 唯一写路径：所有 replan/preview 落库仅经 ReplanCoordinatorService/PlanService 在 buildGucSettings(ctx) 事务内；preview 一律 readonly 不落库。
- 全部新增契约字段可选、配置缺省=现状；回滚=恢复配置默认 + 删除新增可选字段。
- 租户隔离：影响分析基于 org 快照；风暴计数/SSE/KPI 均按 org 隔离。
- Python Edge 不动；无必要 DB migration。
- 测试矩阵：impact-propagation 确定性、replan-storm 抑制、默认 objective 回归、candidate parity（#17）、preview readonly、SSE 事件、canary 回退。
