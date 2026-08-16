# ADR-063：Learning Proposal Activation Decision 接线（Decision Catalog kind #7，NO-13n）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-047（Canonical Decision Model + Decision Catalog v1）、
  ADR-026（Learning Proposal 台账）、ADR-048/057/059/060/061/062
  （kind #1-#6 投影先例）、§2/§10/§12/§18/§33

## 背景

Decision Catalog kind #1-#6 已进入生产调用链。kind #7 =
learning_proposal_activation：学习提案（ADR-026 台账，§10 Level 7
Learning Loop）的激活/拒绝/回滚是真实人审决策事实（§2 激活阶梯
唯一入口 = approve，绝不自动批准；reject/rollback 理由必填），
必须以契约形态留痕进 Decision History（§12）。

## §29 十八问（实现前作答）

1. **Domain**：Learning Loop 策略阈值提案激活（§10 L7 + §12 反馈腿）。
2. **Canonical Contract**：DecisionRecord（ADR-047）+ validateDecision
   （§31 单一实现）；风险阶梯复用 risk 契约（§31）。
3. **Authoritative Source**：提案事实 = ewoh_learning_proposal
   台账行（ADR-026 唯一权威源；proposalId/kind/approvedBy/
   rejectedReason/rolledBackReason）；决策投影读自同一真实事实，
   不新建事实源（§3）。
4. **如何改变 Factory World**：不改世界状态——激活/拒绝/回滚动作
   留痕（decision_json 随台账行持久化）；阈值应用仍由
   getActiveThresholds 既有路径（approved 且未回滚才生效）。
5. **Event**：不新增事件目录类型；LearningProposalResolved 既有
   事件保持（决策台账为结构化 Decision History）。
6. **谁消费**：审计/可解释性消费面（Decision Catalog 统一检索）；
   检索端点后续立项（与 ADR-059/060/061/062 决策 3 同边界）。
7. **失败会怎样**：投影缺口/契约门失败 → log 显式 + 不写
   decision_json（§33 绝不静默丢弃、绝不伪造）——**绝不阻断提案
   主流程**（§2，与 ADR-057/059/060/061/062 同纪律）；状态机
   非法转移仍走既有 requireTransition 显式拒绝。
8. **离线会怎样**：云侧同 UPDATE 语句原子写；无外部依赖。
9. **重复消息会怎样**：状态机单向转移（requireTransition）保证
   单次解析；decisionId = decision:<proposalId>:activation
   （确定性幂等——同一提案至多一条激活决策）。
10. **权限边界**：approve/reject/rollback 授权链不变。
11. **租户边界**：orgId 取自服务入参（RLS 已兜底，standalone_045）。
12. **安全风险**：决策留痕不扩大执行面；阈值激活不隐式自动执行
    （§2 人审阶梯不变）。
13. **Human Approval**：requiresApproval=false（本决策即人审事实
    本身——approve/reject/rollback 均强制人审身份+理由）。
14. **如何解释 Decision**：selected.reason=理由事实（批准缺省
    'approved' / 拒绝·回滚 = 必填理由）；options=opt:activate/
    opt:keep；evidence 携带 proposal/kind 链接；authority=human
    （三路径均人审）；riskLevel='medium' 类型推导规则（阈值激活
    间接触发调度建议面——规则显式声明锁测试，非伪造）。
15. **如何测试**：decision-projection.spec +3 例（approve 判定
    事实 / reject+rollback 理由映射 / 缺口显式）+ learning-
    proposal.service.spec +3 例（三路径 decisionJson 落库 +
    validateDecision 门）。
16. **如何审计**：auditTrail=[{actor: user:<by>, action: approved
    |rejected|rolled_back, at}]；approver 判定事实（三路径均必带
    人审 by）。
17. **如何迁移**：standalone_053 ewoh_learning_proposal +=
    decision_json jsonb（既有受管表原地加固；managed_count/
    physical_create_count 不变 74/77；旧行 NULL=未投影，additive）；
    schema-manifest 状态 new→altered + note。
18. **如何回滚**：standalone_053.rollback.sql DROP COLUMN +
    run_migrations 注册回滚命令 + standalone-postgres-check.sh
    成对回滚断言。

## 决策

### 决策 1：projectLearningProposalActivationDecision 纯投影（契约门内）

- **decisionId**：`decision:<proposalId>:activation`（确定性幂等
  ——状态机单向转移保证同一提案单次解析）；
- **kind**=learning_proposal_activation；
- **status**：approve→approved / reject→rejected / rollback→
  superseded（激活决策被回滚取代——词表内最贴合语义）；
- **decisionAuthority**=human（三路径均强制人审身份 + 理由）；
- **subject**=`proposal:<proposalId>`；**tenantId**=orgId；
- **riskLevel**='medium'（类型推导规则锁测试：阈值激活间接触发
  调度建议面）；
- **requiresApproval**=false；**options**=opt:activate（reason=
  `kind:<kind>`）/opt:keep；**selected**：approve→opt:activate
  （reason 缺省 'approved'）；reject/rollback→opt:keep（reason=
  必填理由事实）；
- **approver**={actor: `user:<by>`, at}；**evidence**=[
  `proposal:<proposalId>`, `kind:<kind>`]；
- **auditTrail**=[{actor: `user:<by>`, action: approved|rejected|
  rolled_back, at}]；
- validateDecision 门：失败 → 显式缺口。

### 决策 2：持久化 = 台账列（与状态转移同 UPDATE 原子）

standalone_053：ewoh_learning_proposal += `decision_json jsonb`
（ADR-047 契约形态 DecisionRecord；NULL=存量未投影行）。approve/
reject/rollback 的状态 UPDATE 语句内直接携带 decisionJson
（投影成功时）——决策记录与状态终态**同一 UPDATE 原子**落库
（比 ADR-059 的追加参数更紧：零额外写路径）。投影缺口 → 不写
（留 NULL）+ log 显式。

### 决策 3：缺口不阻断 + 检索端点后续立项

投影缺口/契约门失败 → logger.warn 显式（§33）；跨 kind Decision
History 检索端点仍为后续立项（与 ADR-059/060/061/062 决策 3 同
边界）。

## 后果

- 正：Decision Catalog kind #7 进入生产调用链（学习提案激活/拒绝/
  回滚三路径留痕）；判定事实完整（authority/approver/status 映射/
  evidence 链接/风险推导规则）；决策历史单一事实源 §12；无额外写
  路径（同 UPDATE 原子）。
- 负：台账行新增 jsonb 列（存量行 NULL，读回兼容）。
- 无破坏性变更（additive；无 OpenAPI/env 变更；计数不变 74/77）。
