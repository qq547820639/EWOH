# ADR-059：Agent Approval Decision 接线（Decision Catalog kind #3，NO-13j）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-047（Canonical Decision Model + Decision Catalog v1）、
  ADR-039（Agent 审批跨重启持久化台账）、ADR-048/057（决策投影机制
  与 plan_approval 接线先例）、§2/§11/§12/§18/§33

## 背景

Decision Catalog kind #1（task_assignment，ADR-048）与 #2
（plan_approval，ADR-057）已进入生产调用链。kind #3 = agent_approval：
Agent 命令审批解析（ADR-039 台账 CAS）是真实的人审决策事实，必须
以契约形态留痕进 Decision History（§12）——不留推理痕迹缺口。
判定事实全部可得：agentId / command / approvalId / 解析人 /
manifest.riskLevel（真实清单事实，封闭词表 low/medium/high/
critical）。

## §29 十八问（实现前作答）

1. **Domain**：Agent 审批决策（§11 Multi-Agent + §12 Knowledge）。
2. **Canonical Contract**：DecisionRecord（ADR-047）+ validateDecision
   （shared/decision.ts，§31 单一实现）；Agent Manifest 契约
   （riskLevel 封闭词表）。
3. **Authoritative Source**：审批事实 = ewoh_agent_approval 台账
   （ADR-039 唯一权威源）；决策投影读自同一台账行的真实字段，不新建
   事实源（§3）。
4. **如何改变 Factory World**：不改世界状态——审批解析的事实留痕
   （decision_json 随台账行持久化）；批准路径的 world 变更仍由
   executeAuthorized 既有路径执行（§11 正式能力接口）。
5. **Event**：不新增事件目录类型；recordDecisionEvent 既有审计事件
   保持（决策台账为结构化的 Decision History 而非事件流）。
6. **谁消费**：审计/可解释性消费面（Decision Catalog 统一检索）；
   检索端点后续立项（本 ADR 决策 3）。
7. **失败会怎样**：投影缺口（无租户/无操作者/契约门失败）→ log 显式
   + resolution 不写 decision_json（NULL 存量语义）——**绝不阻断审批
   主流程**（§2/§33，与 ADR-057 同纪律）；CAS 未命中（重复解析）→
   既有 approval_already_resolved 显式拒绝（不重复写决策）。
8. **离线会怎样**：云侧台账事务内写；无外部依赖。
9. **重复消息会怎样**：CAS（WHERE status='pending'）保证单次解析；
   decisionId = decision:<approvalId>:agent-approval 确定性幂等
   （同一 approval 至多一条决策记录）。
10. **权限边界**：解析人 = 既有 resolve API 授权链（不改）。
11. **租户边界**：orgId 取自台账行（RLS 已兜底，ADR-039）。
12. **安全风险**：决策留痕不扩大执行面；批准执行仍经 executeAuthorized
   全链路（budget/timeout/fallback）。
13. **Human Approval**：本决策即审批事实（requiresApproval=false，
    与 ADR-057 同语义）；agent 命令本身的审批需求不变。
14. **如何解释 Decision**：selected.reason = 解析事实（批准理由/
    人工驳回/approval_expired）；options = approve/reject 两选项；
    evidence 携带 manifest_risk:<level> 原始事实（critical 映射后
    不丢信息）；authority 区分 human（人工解析）与 policy
    （TTL 超期自动拒绝）。
15. **如何测试**：decision-projection.spec +4 例（approved 判定事实
    完整 / rejected 人工驳回 / expired policy authority 无操作者 /
    缺口显式 + 契约门失败）+ agent.service.spec 持久化 +3 例
    （approve/reject/expired → decisionJson 落库形态）+ verify
    SQL 形状自证。
16. **如何审计**：auditTrail 首个条目 = 解析人/策略 actor +
    动作（approved/rejected/expired）+ 时间；approver 判定事实
    （human → user:<id>；policy → policy:agent-approval-ttl）。
17. **如何迁移**：standalone_052 ewoh_agent_approval += decision_json
    jsonb（既有受管表原地加固；managed_count/physical_create_count
    不变 74/77；旧行 NULL=未投影，additive）；schema-manifest 状态
    new→altered + note。
18. **如何回滚**：standalone_052.rollback.sql DROP COLUMN +
    run_migrations 注册回滚命令 + standalone-postgres-check.sh 成对
    回滚断言。

## 决策

### 决策 1：projectAgentApprovalDecision 纯投影（契约门内）

- **decisionId**：`decision:<approvalId>:agent-approval`（确定性
  幂等——ADR-039 CAS 保证同一 approval 单次解析）；
- **kind**=agent_approval；**status**=approved / rejected（expired
  → rejected，reason=approval_expired）；
- **decisionAuthority**：人工解析=human；TTL 超期=policy（解析人
  不存在——事实区分，不伪造 human 身份）；
- **subject**=`agent:<agentId>`；**tenantId**=台账行 orgId；
- **riskLevel**：manifest.riskLevel → 决策阶梯映射（low→low /
  medium→medium / high→high / critical→high——critical 为清单专属
  档，决策阶梯最高档 high，收敛不丢事实：evidence 携带
  `manifest_risk:critical` 原始档；映射规则锁测试）；
- **requiresApproval**=false（本决策即审批事实）；
- **options**：opt:approve / opt:reject；**selected.reason**：批准
  理由缺省 'approved'、人工驳回缺省 '人工驳回'、过期 'approval_
  expired'；
- **approver**：human → actor=`user:<userId>`；policy →
  actor=`policy:agent-approval-ttl`；at=decidedAt；
- **auditTrail**：[{actor, action: approved|rejected|expired, at}]；
- **evidence**：['manifest_risk:<level>', 'command:<command>']（原始
  事实留痕）；
- validateDecision 门：失败 → 显式缺口（不落库、log 显式）。

### 决策 2：持久化 = 台账列（唯一权威写路径）

standalone_052：ewoh_agent_approval += `decision_json jsonb`
（ADR-047 契约形态 DecisionRecord；NULL=存量未投影行）。resolveRow
CAS 更新时同事务写入投影记录（解析三路径各产一条：approved /
rejected / expired）——决策记录与解析终态原子同落，无第二事实源。

### 决策 3：缺口不阻断 + 检索端点后续立项

投影缺口/契约门失败 → logger.warn 显式 + decision_json 留 NULL
（§33 绝不静默丢弃、绝不伪造）；审批主流程（resolve/execute/审计）
语义不变（§2）。Decision History 统一检索端点（跨 kind 查询）为
后续立项（本 ADR 显式边界：台账列 = 事实源，读面后补）。

## 后果

- 正：Decision Catalog kind #3 进入生产调用链（agent 审批解析三
  路径全部留痕）；判定事实完整（authority/approver/riskLevel 源自
  真实台账与清单）；决策历史单一事实源 §12。
- 负：台账行新增 jsonb 列（存量行 NULL，读回兼容）。
- 无破坏性变更（additive；无 OpenAPI/env 变更；计数不变）。
