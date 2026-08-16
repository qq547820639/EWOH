# ADR-048：Decision 契约生产投影接线（DecisionTrace→DecisionRecord 唯一投影点，NO-12y）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-047（Canonical Decision Model 契约层，决策 2 的后续轮次）、
  ADR-043/ADR-044（Capability 契约→投影接线同纪律）、§3（Factory Truth）、
  §12（Decision History）、§18（可解释性）、§24（Decision Catalog）、§30/§31/§33

## 背景

ADR-047 落地了 DecisionRecord 契约层（契约 + 双实现 + 545/545 门禁 +
Golden 第 24 场景），但 DecisionRecord 尚未进入生产调用链——决策历史
仍是 TS 内嵌 DecisionTrace（形状专用、无规范 ID、无审批/风险/租户判定
事实）。按 §36 口径 canonical-decision-model 保持 Partial。

本轮把契约接入生产：求解器产出的 DecisionTrace 在唯一投影点转换为
DecisionRecord，随方案持久化（决策历史单一事实源），§18 解释面与
§12 决策历史自此消费契约形态。

## §29 十八问（实现前作答）

1. **Domain**：Scheduler Decision 生产路径（云侧 plan 持久化链）。
2. **Canonical Contract**：`ewoh:///decision/decision/v1`（ADR-047，
   R-68 已落地，本轮消费）。
3. **Authoritative Source**：contracts/decision/*（记录形状）；投影
   规则（DecisionTrace→DecisionRecord 字段映射）由本 ADR + 投影模块
   测试锁定（§31 单一语义，无第二实现）。
4. **如何改变 Factory World**：不改变世界状态——DecisionRecord 是
   决策审计/解释事实；随 ewoh_schedule_plan 持久化（standalone_050），
   getPlan 读回，UI 解释面/Outcome 标注（targetType=decision）可链接。
5. **Event**：无新事件类型（决策记录随 plan 持久化路径落地；方案
   生命周期事件既有）。
6. **谁消费**：plan 查询面（解释/审计）、Outcome 标注反向链接、
   决策历史检索（后续轮次）。
7. **失败会怎样**：投影显式缺口计数（decisionProjectionIssues：
   decision_tenant_unknown / decision_no_selected_reason /
   decision_invalid:<errorCode>）——绝不静默丢弃、绝不伪造字段
   （§33）；记录缺失可见可查。
8. **离线会怎样**：投影在云侧持久化路径内（无边缘参与；契约校验
   本身离线可用——Python 实现已锁步）。
9. **重复消息会怎样**：decisionId = `decision:<planId>:<taskId>`
   确定性推导（幂等）；persistPlan 单事务写入。
10. **权限边界**：投影只读 trace + ctx（不改写求解结果）；写入
    走既有 plan 持久化权限路径。
11. **租户边界**：tenantId = ctx.primaryOrgId（与 plan.org_id 同源）；
    orgId 缺失 → 显式缺口跳过（绝不伪造租户）。
12. **安全风险**：riskLevel 映射自真实 route-graph 风险事实
    （决策 2）；requiresApproval=true 恒真（task_assignment 提议
    必经方案审批，§2 human-in-the-loop 事实留痕）。
13. **Human Approval**：本轮记录 status=proposed + authority=
    optimization（求解提议）；approver 事实由 plan_approval 类决策
    记录承接（后续轮次接线）。
14. **如何解释 Decision**：selected.reason ← trace.selectedReason
    （非空强制）；options ← trace.candidates（评分）；rejected ←
    trace.rejectedAlternatives/rejectedHard（结构化拒绝原因）；
    hardConstraints/weightsSnapshot/snapshotRef 随 trace 直传
    （§18 解释来自真实求解数据）。
15. **如何测试**：decision-projection.spec 等价断言（trace 字段 →
    记录字段逐字一致 + 契约校验通过 + 缺口显式 + ID 确定性）+
    plan.service 持久化往返（persist→getPlan 记录一致）。
16. **如何审计**：auditTrail = solver 决定事实（actor=规范身份、
    at=decidedAt）；记录本身入 plan JSONB（与既有 audit log 互补）。
17. **如何迁移**：standalone_050 原地加固（ewoh_schedule_plan +=
    decision_records_json JSONB；受管表计数不变 73/76）；additive
    字段向后兼容（旧行 NULL=未投影）。
18. **如何回滚**：DROP COLUMN IF EXISTS（standalone_050.rollback）；
    投影调用点为 additive 字段，摘除后语义回到 R-68。

## 决策

### 决策 1：唯一投影点 = persistPlan（方案持久化唯一写路径）

`decision-projection.ts` 纯模块：
- `projectTaskAssignmentDecision(trace, plan, ctx)`：DecisionTrace →
  DecisionRecord（kind=task_assignment / status=proposed /
  decisionAuthority=optimization；decisionId=`decision:<planId>:<taskId>`
  确定性幂等；subject=`task:<taskId>`；decidedAt=plan.createdAt；
  options ← candidates（optionId 由 person/device/station 组合确定性
  推导；selected 组合不在 options（baseline reuse 快速路径）时以
  score=null + selectedReason 补入——契约不变式 selected∈options，
  语义不变）；selected.reason ← selectedReason 非空过滤（过滤后为空
  → 显式缺口跳过）；rejectedAlternatives ← rejectedAlternatives +
  rejectedHard（rejectReasons 非空过滤）；hardConstraints/
  weightsSnapshot/policyVersion/solverVersion/snapshotRef 直传；
  auditTrail=[solver 决定事实]）。
- persistPlan 内先投影后落库：所有持久化方案必带 decisionRecords
  （或显式缺口计数 decisionProjectionIssues）——单点写入保证决策
  历史完整，无散落第二写入路径。
- 生成记录必过 `validateDecision`（共享契约实现 §31）；失败 →
  decision_invalid:<code> 显式缺口，绝不静默。

### 决策 2：riskLevel 映射规则（确定性 + 锁测试）

决策记录 riskLevel 映射自真实 route-graph 风险事实（非猜测）：
assignment.riskLevel（路径风险：high/medium/null）→ decision
riskLevel：high→high、medium→medium、null→**low**——null 的语义是
「路径上无被标记的高/中风险边」（routing.service.routeRiskLevel 的
显式事实），即平台风险模型下的低风险档合法读数；映射规则入本 ADR +
投影测试锁定（与 ADR-007 legacy 严重度归一同性质：显式确定性映射，
非伪造）。requiresApproval=true 恒真（task_assignment 提议必经方案
审批，§2 人审事实留痕）。

### 决策 3：持久化（standalone_050 原地加固）

ewoh_schedule_plan += `decision_records_json` JSONB（既有受管表
原地加固，managed_count/physical_create_count 不变 73/76；
standalone_001/001_verify 预期清单不变——表已计数）。drizzle
schema.ts 同步加列；persistPlan 写、toPlanV2 读回；SchedulingPlanV2
additive += decisionRecords + decisionProjectionIssues。

## 后果

- 正：§12 Decision History 单一事实源进入生产调用链（决策记录随
  方案持久化，可检索/可链接/可解释）；§18 解释面可消费契约形态；
  canonical-decision-model §36 全绿升 Implemented（矩阵 50/5/0/1）。
- 负：plan_approval/agent_approval 等其余 7 类 kind 的接线为后续
  轮次（本轮 task_assignment 先贯通——目录已备，逐类收敛）。
- 无破坏性变更（全 additive；旧行 NULL=未投影，读回兼容）。
