# ADR-061：Dispatch Decision 接线（Decision Catalog kind #5，NO-13l）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-047（Canonical Decision Model + Decision Catalog v1）、
  ADR-048/057/059/060（kind #1-#4 投影先例）、§2（Dispatch 步骤）、
  §12/§18/§33

## 背景

Decision Catalog kind #1-#4 已进入生产调用链。kind #5 = dispatch：
派工链（§2：Policy→Authorization→State Revalidation→Reservation→
**Dispatch**→Audit）中，DispatchCoordinator 完成派工（方案
dispatched + 任务推进 + 分配事件 + 出站事件）是真实协调决策事实，
必须以契约形态留痕进 Decision History（§12）——与 kind #4
（reservation）共同覆盖派工链全链。

## §29 十八问（实现前作答）

1. **Domain**：Scheduler 派工（§7/§8 协调决策）。
2. **Canonical Contract**：DecisionRecord（ADR-047）+ validateDecision
   （§31 单一实现）；风险阶梯复用 risk 契约（§31）。
3. **Authoritative Source**：派工事实 = DispatchCoordinator 同事务
   内的真实动作（assignmentCount / outboxEventIds / 分配状态
   dispatched）；决策投影读自同一真实事实，不新建事实源（§3）。
4. **如何改变 Factory World**：不改世界状态——派工动作留痕
   （decision_records_json 随方案持久化，与派工同事务）；world
   变更仍由既有 dispatch 路径执行。
5. **Event**：不新增事件目录类型；assignment.dispatched /
   plan.dispatched 出站事件保持（决策台账为结构化 Decision History，
   evidence 携带 outbox 事件 id 链接）。
6. **谁消费**：审计/可解释性消费面（Decision Catalog 统一检索；
   getPlan 读回已自动携带 decisionRecords）。
7. **失败会怎样**：投影缺口/契约门失败/追加失败 → log 显式 +
   不追加（§33）——**绝不阻断派工主流程**（§2，与 ADR-057/059/
   060 同纪律）；派工本身失败（CAS/冲突）→ 事务整体回滚（无部分
   提交，决策记录随事务回滚）。
8. **离线会怎样**：云侧事务内写；无外部依赖。
9. **重复消息会怎样**：double-dispatch 由 CAS（PLAN_CONCURRENT_
   DISPATCH）守卫；decisionId = decision:<planId>:dispatch
   （确定性幂等——同一方案至多派工一次）。
10. **权限边界**：派工授权链不变（approve 后 dispatch）。
11. **租户边界**：orgId 取自派工 ctx（RLS 已兜底）。
12. **安全风险**：决策留痕不扩大执行面；safety-blocked 熔断仍在
    派工链最前（既有）。
13. **Human Approval**：requiresApproval=false（审批事实在 kind
    #2 plan_approval）。
14. **如何解释 Decision**：selected.reason 携带真实派工数
    （dispatched:<count>）；options=opt:dispatch（reason=assignments:
    <count>）/opt:hold；evidence 携带 outbox 事件 id 链接 +
    assignments:<count>；authority=policy（派工链含政策门
    SAFETY_BLOCK_DISPATCH / ADVISORY fail-closed / 快照新鲜度）；
    riskLevel=分配风险档聚合（max 规则，锁测试）。
15. **如何测试**：decision-projection.spec +3 例（判定事实完整 /
    风险聚合 max 规则 / 缺口显式）+ dispatch-integration.spec 主链
    路断言补强（派工后方案决策台账含 kind #5 + getPlan 读回携带）。
16. **如何审计**：auditTrail=[{actor: user:<id>|system:dispatch,
    action: 'dispatched', at}]；decision_records_json 随方案持久化。
17. **如何迁移**：无 DB/env/OpenAPI 变更（消费既有
    decision_records_json 列）。
18. **如何回滚**：删除投影调用 + 追加代码即回滚（无 schema 变更）。

## 决策

### 决策 1：projectDispatchDecision 纯投影（契约门内）

- **decisionId**：`decision:<planId>:dispatch`（确定性幂等——
  double-dispatch CAS 保证同一方案至多派工一次）；
- **kind**=dispatch；**status**=executed（派工已实际完成——执行
  步骤留痕非提议）；
- **decisionAuthority**=policy（派工链含政策门：SAFETY_BLOCK_
  DISPATCH / ADVISORY fail-closed / 快照新鲜度强校验）；
- **subject**=`plan:<planId>`；
- **riskLevel**=分配风险档聚合（max 规则：任一 high→high，否则
  任一 medium→medium，否则 low——复用 ADR-048 决策 2 单条映射，
  聚合规则锁测试）；
- **requiresApproval**=false；**options**=opt:dispatch（reason=
  `assignments:<count>`）/opt:hold；**selected**=opt:dispatch，
  reason=`dispatched:<count>`（真实派工数）；
- **evidence**：`assignments:<count>` + outbox 事件 id 链接
  （`outbox:<eventId>`——真实出站事件链接）；
- **auditTrail**=[{actor: user:<operator> | system:dispatch,
  action: 'dispatched', at}]；
- validateDecision 门：失败 → 显式缺口。

### 决策 2：追加 = 派工事务内单次写（与 kind #4 合并）

DispatchCoordinator.dispatch 事务内：预占循环收集真实 reserve()
结果 → 投影 kind #4 记录；出站事件完成后投影 kind #5 记录 →
**单次**读-追加-回写 decision_records_json（无第二事实源；与派工
同事务原子）。投影缺口/追加失败 log 显式不阻断派工（§2/§33）。

### 决策 3：缺口不阻断 + 检索端点后续立项

投影缺口/契约门失败 → logger.warn 显式（§33）；跨 kind Decision
History 检索端点仍为后续立项（与 ADR-059/060 决策 3 同边界）。

## 后果

- 正：Decision Catalog kind #5 进入生产调用链（派工链全链留痕：
  kind #2 审批 → #4 预占 → #5 派工）；判定事实完整（authority/
  status/subject/风险聚合规则/outbox 链接）；决策历史与派工同事务
  原子 §12。
- 负：派工事务内单次方案行读-追加-回写（缺口时跳过）。
- 无破坏性变更（无 DB/env/OpenAPI 变更）。
