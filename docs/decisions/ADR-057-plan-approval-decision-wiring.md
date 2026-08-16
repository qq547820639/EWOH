# ADR-057：Plan Approval Decision 接线（Decision Catalog kind #2，NO-13h）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-047（Decision Catalog v1 八类目录）、ADR-048（task_
  assignment 投影唯一写点）、ADR-049/ADR-050（Execution 域审计/
  完成腿）、§12（Decision History 单一事实源）、§18/§33/§36

## 背景

ADR-047 建立了 Decision Catalog v1（8 类 kind），ADR-048 接入了
kind #1（task_assignment：persistPlan 唯一投影点 + standalone_050
decision_records_json 持久化）。计划审批（approve/reject）是 §2
人审门的最重要决策之一，却尚未以契约形态留痕——Decision History
缺口（§12）。本轮接入 kind #2（plan_approval）：approvePlan /
rejectPlan 以 DecisionRecord 形态追加进方案决策台账。

## §29 十八问（实现前作答）

1. **Domain**：Decision 域（§2 人审门——计划审批）。
2. **Canonical Contract**：`ewoh:///decision/decision/v1`（ADR-047；
   复用 validateDecision 共享实现 §31）。
3. **Authoritative Source**：contracts/decision/*；审批事实
   （operator/reason/时间）来自 approvePlan/rejectPlan 既有路径。
4. **如何改变 Factory World**：不改世界状态——审批决策以契约形态
   追加进 ewoh_schedule_plan.decision_records_json（§12 Decision
   History 单一事实源扩展）。
5. **Event**：无新事件类型（审批审计既有 audit log + plan 状态事实）。
6. **谁消费**：决策历史检索、Outcome 标注反向链接（targetType=
   decision）、审批可解释面。
7. **失败会怎样**：投影缺口显式（decision_tenant_unknown /
   decision_no_operator / decision_invalid:<code>）——log 留痕不阻断
   审批主流程（审批是人工决策门，§2 不变）；记录缺失可见可查。
8. **离线会怎样**：云侧（审批路径既有）。
9. **重复消息会怎样**：decisionId=`decision:<planId>:approval:v<version>`
   确定性；同版本重复审批被版本 CAS 拒绝（既有），记录幂等。
10. **权限边界**：审批鉴权既有（不变）；记录写入走既有事务。
11. **租户边界**：tenantId=ctx.primaryOrgId（同源 plan.org_id）。
12. **安全风险**：supervisory（审批事实记录，§2 边界不变）。
13. **Human Approval**：本决策即人审事实——authority=human +
    approver{actor,at} 必填（判定事实完整）。
14. **如何解释 Decision**：selected.reason=审批理由（非空强制；
    operator/reason 来自真实审批输入）。
15. **如何测试**：projection 纯函数（approve/reject/租户缺口/无
    operator/契约门通过）+ approvePlan 台账追加（决策记录落
   decision_records_json 补丁断言）。
16. **如何审计**：DecisionRecord 契约形态（auditTrail + approver +
    reason）+ 既有 audit log 双留痕。
17. **如何迁移**：无 DB/OpenAPI/env 变更（复用 standalone_050 列；
   additive 写路径）。
18. **如何回滚**：摘除 approve/reject 的追加调用即回滚（决策台账
   回到仅 task_assignment 形态）。

## 决策

### 决策 1：projectPlanApprovalDecision（纯投影，契约门内）

decision-projection.ts 增补：
- decisionId=`decision:<planId>:approval:v<version>`（确定性幂等）；
- kind=plan_approval；status=approved/rejected；decisionAuthority=
  human；subject=`plan:<planId>`；
- riskLevel='high'——**类型推导规则**（审批门直通生产派工，阶梯
  语义高位；映射规则锁测试，与 ADR-048 路由风险映射同纪律）；
- requiresApproval=false（本决策即审批事实本身）；
- options=[opt:approve, opt:reject]；selected=实际结果
  （reason=operator 输入理由，缺省用结果动作词——事实非伪造）；
- approver.actor=`user:<operator>` + at=decidedAt；auditTrail 同源；
- validateDecision 门：失败 → decision_invalid:<code> 显式缺口。

### 决策 2：approve/reject 台账追加（唯一写路径）

PlanService.approvePlan / rejectPlan 事务后：读当前
decision_records_json → 追加 plan_approval 记录 → 回写（CAS where
planId）；投影失败 log 显式留痕、绝不阻断审批主流程（§2 人审门
语义不变）。getPlan 既有读回自动携带。

## 后果

- 正：Decision Catalog kind #2 接线（§12 Decision History 覆盖
  求解提议 + 人审结果全链）；canonical-decision-model 证据深化
  （矩阵保持 Implemented）。
- 负：其余 6 类 kind（agent_approval/resource_reservation/dispatch/
  replan/learning_proposal_activation/policy_activation）仍待后续
  逐类收敛（目录已备）。
- 无破坏性变更（additive 写路径；无 DB/OpenAPI/env 变更）。
