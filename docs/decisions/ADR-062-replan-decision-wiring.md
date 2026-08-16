# ADR-062：Replan Decision 接线（Decision Catalog kind #6，NO-13m）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-047（Canonical Decision Model + Decision Catalog v1）、
  ADR-048/057/059/060/061（kind #1-#5 投影先例）、§2/§8（Replan
  步骤）、§12/§18/§31/§33

## 背景

Decision Catalog kind #1-#5 已进入生产调用链。kind #6 = replan：
动态重排（§8：…→ Observe → Feedback → **Replan**）中，Replan
Coordinator 因真实触发（SAFETY_EVENT / RESERVATION_CONFLICT /
DEVICE_OFFLINE 等）经影响分析 + 风暴守卫后产出新方案（shadow）
是真实协调决策事实，必须以契约形态留痕进 Decision History（§12）。
同时收口 §31：方案决策台账读-追加-回写此前在 plan.service
（审批追加，ADR-057）与 dispatch-coordinator（派工追加，
ADR-060/061）各有一份实现——本轮提取单一实现
（decision-ledger.ts），三处消费。

## §29 十八问（实现前作答）

1. **Domain**：Scheduler 动态重排（§8 Replan）。
2. **Canonical Contract**：DecisionRecord（ADR-047）+ validateDecision
   （§31 单一实现）；风险阶梯复用 risk 契约（§31）。
3. **Authoritative Source**：重排事实 = ReplanCoordinator 真实动作
   （run.runId / triggerType / triggerEntityId / impact.affectedTaskIds
   / 新方案 planId——trigger 求值 + 影响分析的同一事实链）；决策投影
   读自同一真实事实，不新建事实源（§3）。
4. **如何改变 Factory World**：不改世界状态——重排动作留痕（新方案
   decision_records_json 随方案持久化）；world 变更仍由既有
   persistPlan→approve→dispatch 链路执行。
5. **Event**：不新增事件目录类型；replan.suppressed /
   schedule.proposed 等既有事件保持（决策台账为结构化 Decision
   History）。
6. **谁消费**：审计/可解释性消费面（Decision Catalog 统一检索；
   getPlan 读回已自动携带 decisionRecords）。
7. **失败会怎样**：投影缺口/契约门失败/追加失败 → log 显式 +
   不追加（§33）——**绝不阻断重排主流程**（§2，与 ADR-057/059/060/
   061 同纪律）；抑制路径（debounce/storm/low-improvement）不产生
   记录（未产方案即无决策——事实一致，不伪造"决定重排"）。
8. **离线会怎样**：云侧写；无外部依赖。
9. **重复消息会怎样**：decisionId = decision:<planId>:replan
   （确定性幂等——同一 planId 至多持久化一次；重复触发经风暴守卫
   debounce 合并）。
10. **权限边界**：重排授权链不变（触发→影响分析→求解→shadow）。
11. **租户边界**：orgId 取自 ctx（RLS 已兜底）。
12. **安全风险**：决策留痕不扩大执行面；SAFETY_EVENT 触发不自动
    派工（既有 shadow→审批边界不变）。
13. **Human Approval**：requiresApproval=true（重排产出 shadow
    方案，必经审批——与 kind #1 同语义）。
14. **如何解释 Decision**：selected.reason=trigger:<type>:affected:
    <n>（触发类型 + 真实影响任务数）；options=opt:replan（reason=
    trigger:<type>）/opt:keep；evidence 携带 run/trigger/affected/
    entity 链接；authority=policy（触发链=政策驱动：debounce/storm/
    影响分析/suppress 门）；riskLevel=触发类型推导规则（锁测试）。
15. **如何测试**：decision-projection.spec +3 例（判定事实 / 风险
    类型规则 / 缺口显式）+ replan-v2-impact.spec +1 例（handleTrigger
    产方案后新方案决策台账含 kind #6）；plan.service / dispatch
    既有 spec 回归（台账读-追加-回写单一实现重构）。
16. **如何审计**：auditTrail=[{actor: policy:replan-trigger,
    action: 'replanned', at}]；decision_records_json 随新方案持久化。
17. **如何迁移**：无 DB/env/OpenAPI 变更；§31 重构（decision-ledger
    单一实现，三处消费行为逐字一致，既有 spec 回归锁定）。
18. **如何回滚**：删除投影调用 + 追加代码即回滚（无 schema 变更）。

## 决策

### 决策 1：projectReplanDecision 纯投影（契约门内）

- **decisionId**：`decision:<planId>:replan`（确定性幂等——同一
  planId 至多持久化一次）；
- **kind**=replan；**status**=proposed（新方案 shadow 待审批）；
- **decisionAuthority**=policy（触发链=政策驱动）；
- **subject**=`plan:<planId>`；
- **riskLevel**=触发类型推导规则（锁测试）：SAFETY_EVENT /
  ZONE_RESTRICTED → high；PERSON_UNAVAILABLE / DEVICE_OFFLINE →
  medium；其余 → low（类比 ADR-057 类型推导规则——触发类型是真实
  事实，规则显式声明）；
- **requiresApproval**=true；**options**=opt:replan（reason=
  `trigger:<type>`）/opt:keep；**selected**=opt:replan，reason=
  `trigger:<type>:affected:<n>`（真实影响任务数）；
- **evidence**：[`run:<runId>`, `trigger:<type>`,
  `affected:<n>`] +（entityId 非空时）`entity:<entityId>`；
- **auditTrail**=[{actor: 'policy:replan-trigger', action:
  'replanned', at}]（自动触发，无人工操作者——不伪造 human 身份）；
- validateDecision 门：失败 → 显式缺口。

### 决策 2：decision-ledger 单一实现（§31 收口）

新模块 decision-ledger.ts：`appendPlanDecisionRecords(db, planId,
records)`（读 decision_records_json → 追加 → 回写，无 CAS——调用方
保证幂等/事务语义）。plan.service（审批追加）、dispatch-coordinator
（派工追加）、replan-coordinator（重排追加）三处消费同一实现，
行为逐字一致（既有 spec 回归锁定）。

### 决策 3：追加 = 重排主流程之后（非阻断）

persistPlan 完成后逐方案追加 kind #6 记录；投影缺口/追加失败 log
显式不阻断重排主流程（§2/§33）；抑制路径（未产方案）不产生记录
（事实一致）。跨 kind Decision History 检索端点仍为后续立项。

## 后果

- 正：Decision Catalog kind #6 进入生产调用链（重排触发→新方案
  决策留痕）；§31 收口（台账追加单一实现）；判定事实完整（触发
  类型/影响数/run 链接/风险推导规则）；决策历史单一事实源 §12。
- 负：重排后多一次方案行读-追加-回写（缺口时跳过）。
- 无破坏性变更（无 DB/env/OpenAPI 变更）。
