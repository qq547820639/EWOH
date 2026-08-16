# ADR-064：Policy Activation Decision 接线（Decision Catalog kind #8，NO-13o）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-047（Canonical Decision Model + Decision Catalog v1）、
  ADR-048/057/059/060/061/062/063（kind #1-#7 投影先例）、§2/§8/
  §12/§18/§33

## 背景

Decision Catalog kind #1-#7 已进入生产调用链。kind #8 =
policy_activation：调度策略版本激活（SchedulerPlanApplication
Service.activatePolicyVersion 人审门：approver+reason 必填 +
POLICY_ALREADY_ACTIVE 守卫 + replay 已评估守卫 → SchedulingPolicy
Service 行翻转）是真实人审决策事实，必须以契约形态留痕进 Decision
History（§12）——本轮完成 Decision Catalog 8 类全收敛。

## §29 十八问（实现前作答）

1. **Domain**：Scheduler 策略治理（§8/§24 版本化策略激活）。
2. **Canonical Contract**：DecisionRecord（ADR-047）+ validateDecision
   （§31 单一实现）；风险阶梯复用 risk 契约（§31）。
3. **Authoritative Source**：激活事实 = ewoh_scheduling_policy 行
   （active 翻转 + updatedBy + updatedAt——唯一权威源）；决策投影读
   自同一真实事实，不新建事实源（§3）。
4. **如何改变 Factory World**：不改世界状态——激活动作留痕
   （decision_json 随策略行持久化，与 active 翻转同一 UPDATE 原子）；
   生产策略行为变更仍由既有 activate→getActivePolicy 路径生效。
5. **Event**：不新增事件目录类型；审计 scheduler.policy.activate
   既有链路保持（决策台账为结构化 Decision History）。
6. **谁消费**：审计/可解释性消费面（Decision Catalog 统一检索）；
   检索端点后续立项（与 ADR-059..063 决策 3 同边界）。
7. **失败会怎样**：投影缺口（全局策略 orgId null 无租户/缺
   approver）/契约门失败 → log 显式 + 不写 decision_json（§33）——
   **绝不阻断激活主流程**（§2）；守卫失败（APPROVER_REQUIRED /
   POLICY_NOT_EVALUATED / POLICY_ALREADY_ACTIVE）仍走既有显式
   拒绝（在投影之前，不产生记录——未激活即无决策，事实一致）。
8. **离线会怎样**：云侧同 UPDATE 原子写；无外部依赖。
9. **重复消息会怎样**：POLICY_ALREADY_ACTIVE 守卫禁止重复激活；
   decisionId = decision:policy:v<version>:activation（确定性幂等
   ——decision_json 单记录列，版本被再次激活时同 id 覆盖为最新一次
   激活决策，语义显式）。
10. **权限边界**：激活授权链不变（approver+reason 人审门）。
11. **租户边界**：orgId 取自 ctx；全局策略（orgId null）→ 投影
    缺口显式跳过（DecisionRecord 契约强制 tenantId——平台级策略
    决策留痕为显式边界，§33 不伪造租户）。
12. **安全风险**：决策留痕不扩大执行面；激活门禁（approver/
    replay 评估）不变。
13. **Human Approval**：requiresApproval=false（本记录即人审激活
    事实本身——approver+reason 为强制守卫）；approver 判定事实。
14. **如何解释 Decision**：selected.reason=人审理由（缺省
    'activated'）；options=opt:activate（reason=version:<v>）/
    opt:keep；evidence=version:<v>；authority=human；riskLevel=
    'high' 类型推导规则（策略激活直接翻转生产调度行为——规则锁
    测试非伪造）。
15. **如何测试**：decision-projection.spec +3 例（判定事实 /
    缺省理由 + 幂等确定性 / 缺口显式）+ policy-version.spec +2 例
    （activate 行翻转 → decisionJson 落库 + validateDecision 门 /
    savePolicy 直接激活路径）。
16. **如何审计**：auditTrail=[{actor: user:<approver>, action:
    'activated', at}]；decision_json 随策略行持久化。
17. **如何迁移**：standalone_054 ewoh_scheduling_policy +=
    decision_json jsonb（既有受管表原地加固；managed_count/
    physical_create_count 不变 74/77；旧行 NULL=未投影，additive）；
    schema-manifest 状态 new→altered + note。
18. **如何回滚**：standalone_054.rollback.sql DROP COLUMN +
    run_migrations 注册回滚命令 + standalone-postgres-check.sh
    成对回滚断言。

## 决策

### 决策 1：projectPolicyActivationDecision 纯投影（契约门内）

- **decisionId**：`decision:policy:v<configVersion>:activation`
  （确定性幂等——单记录列，重复激活同 id 覆盖为最新决策，语义显式）；
- **kind**=policy_activation；**status**=executed（active 翻转已
  完成——执行步骤留痕）；
- **decisionAuthority**=human（approver 强制人审门）；
- **subject**=`policy:v<configVersion>`；**tenantId**=orgId
  （缺失 → 缺口显式）；
- **riskLevel**='high'（类型推导规则锁测试：策略激活直接翻转
  生产调度行为）；
- **requiresApproval**=false；**options**=opt:activate（reason=
  `version:<v>`）/opt:keep；**selected**=opt:activate，reason=
  [reason || 'activated']；
- **approver**={actor: `user:<approver>`, at}；**evidence**=[
  `version:<v>`]；
- **auditTrail**=[{actor: `user:<approver>`, action: 'activated', at}]；
- validateDecision 门：失败 → 显式缺口。

### 决策 2：持久化 = 台账列（与 active 翻转同 UPDATE 原子）

standalone_054：ewoh_scheduling_policy += `decision_json jsonb`
（ADR-047 契约形态 DecisionRecord；NULL=存量未投影行）。激活路径：
SchedulingPolicyService.activatePolicyVersion 的 active 翻转 UPDATE
语句内直接携带 decisionJson（approver 来自入参，reason 由调用方
透传）；savePolicy 直接激活路径在 INSERT values 携带 decisionJson
（reason 缺省 'policy-save-activated'）。SchedulerPlanApplication
Service 把 body.reason 透传给 policyService（additive 可选参数）。

### 决策 3：缺口不阻断 + 检索端点后续立项

投影缺口/契约门失败 → logger.warn 显式（§33）；全局策略（orgId
null）决策留痕为显式边界（契约强制 tenantId，不伪造）；跨 kind
Decision History 检索端点仍为后续立项（与 ADR-059..063 决策 3
同边界）。

## 后果

- 正：Decision Catalog kind #8 进入生产调用链——**8 类 kind 全部
  接线收口**（§12 Decision History 全链覆盖：求解提议/审批/Agent
  审批/预占/派工/重排/学习提案激活/策略激活）；判定事实完整
  （authority/approver/风险推导规则/evidence）；决策历史单一事实
  源 §12。
- 负：台账行新增 jsonb 列（存量行 NULL，读回兼容）。
- 无破坏性变更（additive；无 OpenAPI/env 变更；计数不变 74/77）。
