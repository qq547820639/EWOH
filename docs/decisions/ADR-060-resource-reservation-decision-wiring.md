# ADR-060：Resource Reservation Decision 接线（Decision Catalog kind #4，NO-13k）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-047（Canonical Decision Model + Decision Catalog v1）、
  ADR-048/057/059（kind #1/#2/#3 投影先例）、§2（Reservation 步骤）、
  §12/§18/§33

## 背景

Decision Catalog kind #1（task_assignment）、#2（plan_approval）、
#3（agent_approval）已进入生产调用链。kind #4 = resource_reservation：
方案派工链（§2：Policy→Authorization→State Revalidation→
**Reservation**→Dispatch→Audit）中，DispatchCoordinator 对每个
assignment 的 person/device/station 资源时间窗预占是真实协调决策
事实（ewoh_resource_reservation 台账行，唯一权威源），必须以契约
形态留痕进 Decision History（§12）。

## §29 十八问（实现前作答）

1. **Domain**：Scheduler 资源预占（§7/§8 协调决策）。
2. **Canonical Contract**：DecisionRecord（ADR-047）+ validateDecision
   （§31 单一实现）；风险阶梯复用 risk 契约（§31）。
3. **Authoritative Source**：预占事实 = ewoh_resource_reservation
   台账行（reservationId/resourceType/resourceId/startMs/endMs——
   reserve() 返回值，同一事务内生成）；决策投影读自同一真实事实，
   不新建事实源（§3）。
4. **如何改变 Factory World**：不改世界状态——派工链的预占动作
   留痕（decision_records_json 随方案持久化，与派工同事务）；
   world 变更仍由既有 reserve/dispatch 路径执行。
5. **Event**：不新增事件目录类型；assignment.dispatched 等既有
   出站事件保持（决策台账为结构化 Decision History）。
6. **谁消费**：审计/可解释性消费面（Decision Catalog 统一检索；
   getPlan 读回已自动携带 decisionRecords）。
7. **失败会怎样**：投影缺口（无租户/缺判定事实/契约门失败）→
   log 显式 + 不追加（§33 绝不静默丢弃、绝不伪造）；台账追加失败
   → log 显式——**绝不阻断派工主流程**（§2，与 ADR-057/059 同
   纪律）；预占本身冲突/失败仍走既有 RESOURCE_CONFLICT 语义
   （派工整体回滚，无部分提交）。
8. **离线会怎样**：云侧事务内写；无外部依赖。
9. **重复消息会怎样**：double-dispatch 由 CAS（PLAN_CONCURRENT_
   DISPATCH）守卫；decisionId = decision:<planId>:reservation:
   <assignmentId>:<reservationId>（reservationId 由 reserve() 单次
   生成）——确定性幂等，重复派工不产生重复决策。
10. **权限边界**：派工授权链不变（approve 后 dispatch）。
11. **租户边界**：orgId 取自派工 ctx（RLS 已兜底）；预占行 org_id
    同源。
12. **安全风险**：决策留痕不扩大执行面；safety-blocked 熔断仍在
    派工链最前（既有）。
13. **Human Approval**：requiresApproval=false（本决策是已批准
    方案的执行步骤，审批事实在 kind #2 plan_approval）。
14. **如何解释 Decision**：selected.reason 携带 reservationId +
    资源类型/ID + 时间窗（台账行唯一链接）；options=reserve/skip
    两选项（选 reserve，理由=窗口文本）；evidence 携带
    assignment/task 链接；authority=rule_based（预占输入由
    assignment 字段确定性推导）。
15. **如何测试**：decision-projection.spec +4 例（判定事实完整/
    缺省 actor 系统派工/风险映射复用 ADR-048 规则/缺口显式）+
    dispatch-integration.spec +1 例（派工后方案 decisionRecordsJson
    含 resource_reservation 记录 + 台账链接）。
16. **如何审计**：auditTrail = [{actor: user:<id>|system:dispatch,
    action: 'reserved', at}]；decision_records_json 随方案持久化
    （getPlan 读回自动携带）。
17. **如何迁移**：无 DB/env/OpenAPI 变更（消费既有
    decision_records_json 列与 ewoh_resource_reservation 台账）。
18. **如何回滚**：删除投影调用 + 追加代码即回滚（无 schema 变更）。

## 决策

### 决策 1：projectResourceReservationDecision 纯投影（契约门内）

- **decisionId**：`decision:<planId>:reservation:<assignmentId>:
  <reservationId>`（确定性幂等——reservationId 单次生成 +
  double-dispatch CAS）；
- **kind**=resource_reservation；**status**=executed（预占已实际
  完成——本决策是执行步骤留痕，非提议）；
- **decisionAuthority**=rule_based（预占输入由 assignment 字段
  确定性推导，非优化/人工选择）；
- **subject**=`resource:<resourceType>:<resourceId>`；
- **riskLevel**：复用 ADR-048 决策 2 映射规则（assignment.riskLevel
  → 决策阶梯——同一分配的风险读数，§31 单一规则）；
- **requiresApproval**=false；**options**=opt:reserve（reason=窗口
  文本）/opt:skip；**selected**=opt:reserve，reason=
  `${reservationId}:${resourceType}:${resourceId}:${startMs}-${endMs}`
  （台账行唯一链接，可追溯）；
- **evidence**：[`assignment:<assignmentId>`] +（taskId 非空时）
  [`task:<taskId>`]；
- **auditTrail**=[{actor: user:<operator> | system:dispatch,
  action: 'reserved', at}]；
- validateDecision 门：失败 → 显式缺口。

### 决策 2：追加 = DispatchCoordinator 事务内写（同事务原子）

DispatchCoordinator.dispatch 的预占循环收集 reserve() 真实返回值，
同一事务内读 decision_records_json → 追加 → 回写
（ewoh_schedule_plan）。决策记录与预占行、方案 dispatched 状态
同事务原子落地（无第二事实源）；追加异常 log 显式不阻断派工
（§2/§33）。

### 决策 3：缺口不阻断 + 检索端点后续立项

投影缺口/契约门失败 → logger.warn 显式（§33）；跨 kind Decision
History 检索端点仍为后续立项（与 ADR-059 决策 3 同边界）。

## 后果

- 正：Decision Catalog kind #4 进入生产调用链（派工预占全链路
  留痕）；判定事实完整（authority/status/subject/台账链接/风险
  映射单一规则）；决策历史与派工同事务原子 §12。
- 负：派工事务内多一次方案行读-追加-回写（缺口时跳过）。
- 无破坏性变更（无 DB/env/OpenAPI 变更）。
