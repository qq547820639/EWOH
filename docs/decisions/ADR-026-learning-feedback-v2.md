# ADR-026：Learning Loop 反馈腿 v2 —— 规则阈值策略更新闭环（人审激活阶梯）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-020（工业推理层）、ADR-021（持续学习回路 v1）、§2（安全边界）、§10 Level 7、§12、§18、§33

## 背景

ADR-021（NO-09a）交付了持续学习回路 v1 观察层：LearningEvaluation 契约 +
standalone_041 台账 + 云侧七指标真实聚合，但明确将反馈腿（Decision→Outcome
回流后的策略/模型自动更新）留待 v2。v1 决策 6 规定：反馈腿必须包含
**outcome 标注面 + 影子评估 + 人审激活阶梯**，且**绝不隐式自动执行**。

本轮（NO-12b）交付反馈腿的策略(规则阈值)部分：学习评估发现的问题可以
显式地变成"阈值调整提案"——经过确定性影子评估与人审批准后，真正作用于
生产推理引擎（rule:worker-overload 的 workload 阈值），并支持人审回滚。

## 决策

### 决策 1：Learning Proposal 是一等契约（canonical，跨运行时事实源）

提案记录字段：

- `proposalId`、`kind`、`status`、`change`（ruleId/parameter/baselineValue/
  candidateValue）、`shadowEval`（影子评估结论）、`evaluationRef`（关联
  LearningEvaluation 的可选引用）、`auditTrail`；
- **kind 封闭注册表 v1 = `rule_threshold`**——只有具备确定性影子评估器的
  类型才允许注册（§33：绝不注册无引擎空类型）。policy_weight / model
  激活类提案留待对应评估器落地后再扩展注册表；
- **status 封闭注册表** = `proposed / shadow_evaluated / approved /
  rolled_back / rejected`，状态机（proposalTransitionAllowed）：
  proposed→shadow_evaluated | rejected；shadow_evaluated→approved |
  rejected；approved→rolled_back。

### 决策 2：影子评估必须是确定性的历史重放，不是 LLM 猜测

`evaluateRuleThresholdShadow(ruleId, baselineThreshold, candidateThreshold,
facts)` 对历史事实窗口按基线阈值与候选阈值各重放一次 worker-overload
触发条件（workload ≥ 阈值 且 (fatigue ≥ 0.7 或 ergonomicRisk ≥ 0.7)），
输出 `baselineFires / candidateFires / addedSubjects / removedSubjects /
riskLevel`。riskLevel 确定性推导：removedSubjects 非空且阈值放宽 ≥ 0.15
→ high；removedSubjects 非空 → medium；否则 low（收紧阈值只增保护 →
low）。解释可追溯：每一条 added/removed 都是历史事实主体，§18 无编造。

影子评估结论随提案落账（shadowEval 字段），批准与回滚都必须基于已存在的
shadowEval（契约机器强制）——无影子证据的激活在验证层即被拒绝（§33）。

### 决策 3：激活阶梯 = 人审，绝不隐式自动执行（§2）

- 激活唯一路径：`shadow_evaluated → approved`，approved 必须携带
  `approvedBy`（规范身份或操作者标识）+ `approvedAt`（机器强制，DB CHECK
  兜底）；不存在任何"自动批准"分支；
- 激活效果：ReasoningService 评估时读取本租户 status=approved 的最新提案，
  以 candidateValue 覆盖 worker-overload 的 workload 阈值（
  evaluateReasoningRules 的 `thresholds` 覆盖参数，Python/TS 语义逐项一致）；
- 回滚：`approved → rolled_back`（rolledBackBy + 非空 rolledBackReason 机器
  强制）；回滚后引擎不再应用该覆盖（阈值回到基线）；
- rejected 必须携带 rejectedBy + 非空 rejectedReason（§33 不静默拒绝）。

### 决策 4：持久化 = standalone_045 ewoh_learning_proposal（TENANT_SCOPED）

- 唯一业务键 `(org_id, proposal_id)` 幂等；CHECK：kind/status 封闭注册表、
  阈值 ∈ [0,1] 且 baseline ≠ candidate、approved/rejected/rolled_back 的
  字段强制、shadow_eval 前置强制；RLS learning_proposal_org_isolation；
- 事件：`LearningProposalCreated` + `LearningProposalResolved`
  （payload.status ∈ {approved, rejected, rolled_back}）；目录 59→61。

### 决策 5：v1 只支持 rule:worker-overload 的 workloadThreshold

THRESHOLD_RULES 注册表 v1 = {rule:worker-overload} × {workloadThreshold}，
且门禁交叉校验 THRESHOLD_RULES ⊆ reasoning-trace ruleRegistry（单一事实源，
与 agent_task assignedRole 交叉核对同纪律）。其余规则阈值随评估器扩展
（每个新参数都需要确定性影子评估器 + 双运行时实现 + 门禁仲裁）。

### 决策 6：云侧运行时接线

LearningProposalService（learning 模块内）：propose（契约 fail-closed，
带 facts 即影子评估落 shadow_evaluated，缺 facts 落 proposed）/
shadow（proposed→shadow_evaluated）/approve/reject/rollback/list/get；
ReasoningService 评估时经 LearningModule 读取 active thresholds
（approved 且未回滚的最新提案）应用覆盖——激活真实进入生产调用链。

## 后果

- 正：学习回路 v2 反馈腿（策略更新）闭环——评估→提案→影子→人审→激活→
  回滚，全部可审计可回滚；worker-overload 阈值调整从"改代码"变为"数据驱动
  的人审配置变更"。
- 负/边界：模型重训/激活闭环与 policy_weight 类提案仍未覆盖（
  intelligence-l7-learning 保持 Partial，缺口收窄为模型腿）；
  影子评估的事实窗口由调用方供给（与 Round 45 what-if 同边界；历史事实
  自动读取接线随 §34 问题驱动后议）。
