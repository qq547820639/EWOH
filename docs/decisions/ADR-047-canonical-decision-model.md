# ADR-047：Canonical Decision Model（跨运行时 Decision 契约 + Decision Catalog，NO-12x）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-006（规范身份）、ADR-007（Risk 阶梯）、ADR-043（Capability
  契约交付纪律）、ADR-034（Outcome 标注——Decision→Outcome 链接侧）、
  §2（关键动作链 Policy→Authorization→Revalidation→Reservation→Dispatch→
  Audit）、§3（Factory Truth：Canonical Decision Model）、§18（可解释性）、
  §24（Decision Catalog）

## 背景

§3 要求 Canonical Decision Model 作为跨运行时事实源；§2 的关键动作链
每一步都是"决策"（谁、为何、依据什么、风险几何、是否需人审）。现状：

- 决策结构只存在于 TS 侧 `DecisionTrace`（shared/scheduler.ts），是
  task_assignment 专用内嵌形状（person/device/station 选择），无独立
  跨运行时契约；
- Python 边缘侧没有对应的决策语义（无法在离线场景做同语义校验）；
- 决策种类无目录（Decision Catalog）：plan 审批（PlanService.
  approvePlan）、agent 审批（R-60 台账）、资源预约（resource-
  reservation）、派工（dispatch-coordinator）、重排（replan-
  coordinator）、学习提案激活（learning-proposal approved）、策略
  激活（policy-activation）各有各的隐式记录形状，无法统一审计/
  解释/回流（§12 Decision History、§18 可解释性、§24 Decision
  Catalog 均缺单一事实源）。
- 已有 Outcome 标注契约的 targetTypeRegistry 含 `decision`
  （Decision→Outcome 链接方向已预留），但 Decision 侧没有可链接的
  规范对象。

canonical-decision-model 据此保持 Partial（矩阵口径）。

## §29 十八问（实现前作答）

1. **Domain**：Decision 域（新契约域 `decision`，§2 关键动作链产物）。
2. **Canonical Contract**：新建 `ewoh:///decision/decision/v1`
   （本轮建立；此前无契约）。
3. **Authoritative Source**：`contracts/decision/decision.schema.json`
   + `decision.test-vectors.json`（单一事实层；Python/TS/仲裁三者
   锁步消费）。
4. **如何改变 Factory World**：契约层不直接改世界状态——DecisionRecord
   是审计/解释/回流事实；生产接线（DecisionTrace→DecisionRecord 投影，
   下一轮 NO-12y）入快照后参与 §18 解释面与 §12 决策历史。
5. **Event**：本轮无新事件类型（契约层）；决策记录随既有 plan/
   approval 持久化路径落地（事件面后续轮次立项）。
6. **谁消费**：求解器/派工/审批服务写入；UI 解释面、Outcome 标注
   （targetType=decision 链接）、审计存储消费。
7. **失败会怎样**：校验 fail-closed——未知 kind/status/authority/风险
   等级显式拒绝（绝不静默归一）；错误码列表可解释。
8. **离线会怎样**：边缘用同一 Python 实现离线校验（双实现目标）；
   记录不依赖云可达性。
9. **重复消息会怎样**：契约层只约束形状；decisionId 幂等去重归
   持久化层（与 event_dedup 同分工）；ID 规范前缀 `decision:` 保证
   全局可寻址。
10. **权限边界**：契约不做授权（授权在服务层）；auditTrail 强制 +
    approver 判定事实完整保证事后可审计。
11. **租户边界**：tenantId 必填（多租户事实隔离；与 entity 契约
    bad_tenant 口径一致）。
12. **安全风险**：riskLevel 封闭阶梯（复用 risk 契约 SEVERITY_LADDER，
    单一事实源）；requiresApproval 显式布尔（高风险默认人工在环
    由服务层执行，契约记录事实）。
13. **Human Approval**：decisionAuthority=human 或 status∈{approved,
    rejected} 时 approver（actor+at）必填——"谁批的、何时批的"是
    判定事实（§33 不伪造）。
14. **如何解释 Decision**：options（候选+评分）+ selected.reason
    （非空强制）+ rejectedAlternatives.rejectReasons + hardConstraints
    + weightsSnapshot——解释必须来自真实约束/评分/策略数据（契约
    形状强制"有理由"；§18）。
15. **如何测试**：共享测试向量（Python/TS 双实现逐条）+ audit-domain-
    contracts decision 域独立 JS 仲裁 + Golden 第 24 场景双执行器 +
    本机 pytest/jest 回归。
16. **如何审计**：auditTrail 非空强制（actor 规范身份 + action +
    ISO 时间逐条校验）+ approver 判定事实 + replay 字段
    （policyVersion/solverVersion/snapshotRef/weightsSnapshot）。
17. **如何迁移**：无 DB 变更（本轮）；DecisionTrace 保持不变（合法
    TS 形状），向契约收敛的投影接线为下一轮（§30：先修契约再修
    实现）。
18. **如何回滚**：契约文件/双实现/仲裁行/Golden 场景全部为新增
    additive 文件——回滚 = 删除新增文件 + 还原仲裁与 Golden 清单。

## 决策

### 决策 1：DecisionRecord 契约（结构封闭 + 判定事实完整）

`contracts/decision/decision.schema.json` + 共享向量 + Python/TS 双实现
+ audit-domain-contracts decision 域 + Golden 第 24 场景：

- **kind 封闭注册表（Decision Catalog v1，8 类）**：
  task_assignment / plan_approval / agent_approval /
  resource_reservation / dispatch / replan /
  learning_proposal_activation / policy_activation——目录与 §2 动作链
  及既有服务一一对应（每类均有生产调用方，非虚构目录）；
- **status 封闭注册表（5 态）**：proposed / approved / rejected /
  executed / superseded（决策自身生命周期；与 PlanStatus 的映射在
  投影接线轮定义）；
- **decisionAuthority 封闭注册表（5 类）**：policy / optimization /
  rule_based / human / agent（谁产出了该决策内容）；
- **riskLevel 复用 risk 契约 SEVERITY_LADDER**（critical/high/medium/
  low）——不在决策契约重复定义（§31 无第二事实源；仲裁门禁逐位
  比对 schema↔risk 契约↔双实现）；
- **判定事实完整**（§33）：
  - decisionId 规范前缀 `decision:`；subject 规范身份形状
    （`<prefix>:<value>`，深校验归 identity 域）；
  - tenantId 必填；requiresApproval 显式布尔；
  - **selected.reason 非空强制**（解释必须给出真实理由）；
  - selected.optionId 必须在 options 中（选中的必是考虑过的，
    §18 不编造）；options 内 optionId 唯一；
  - decisionAuthority=human 或 status∈{approved, rejected} →
    approver{actor,at} 必填；approver.at ≥ decidedAt（时间不倒退）；
  - auditTrail 非空强制（actor 规范身份 + action 非空 + at ISO）；
  - 可选 replay 字段：policyVersion / solverVersion / snapshotRef /
    weightsSnapshot / hardConstraints / evidence / outcomeRef
    （Decision→Outcome 链接侧：outcome 标注 targetType=decision
    反向链接已存在，双向均可寻址）。

### 决策 2：契约层先行（投影接线为下一轮 NO-12y）

本轮交付契约层（schema/向量/双实现/仲裁/Golden + 本机回归），
DecisionTrace→DecisionRecord 生产投影（求解器/审批/派工写入决策
记录并进快照）为下一轮——与 ADR-043→ADR-044 同纪律（先立单一
事实源，再逐点收敛，§30）。矩阵 canonical-decision-model 在投影
接线落地后升 Implemented。

## 后果

- 正：§3 Canonical Decision Model 落地（Decision Catalog 8 类封闭
  注册表 + 判定事实完整 + 跨语言锁步仲裁）；§24 Decision Catalog
  有单一事实源；§12 Decision History / §18 可解释性获得可链接的
  规范对象。
- 负：契约层未接线前 DecisionRecord 尚不参与生产调用链（矩阵保持
  Partial 直至 NO-12y；§36 自我审查口径不变）。
- 无破坏性变更（全 additive；DecisionTrace 形状不变）。
