# ADR-073：Scheduler 读面组织隔离第三波（conflict/feedback/kpi/execution/compare/policy-activation，NO-13x）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-071/072（前两波读面守卫）、ADR-004、standalone_025、
  §15/§3/§33

## 背景

NO-13x 仓库事实扫描（R-94）复核调度域剩余读面与聚合面，发现六类
跨租户缺口：

1. **conflict 读面**：ewoh_scheduling_conflict 有 org_id 但**无
   RLS policy**（025 八条 policy 不含 conflict）；listConflicts/
   getConflictDetail 的 loadAllRows/findRowByConflictId 读全租户
   行——跨租户冲突生命周期泄漏（应用层唯一执行面，无 DB 兜底）；
2. **feedback 读面 + KPI 聚合**：scheduling-feedback.service
   list()/deriveKpis() 读全租户反馈行；kpi.aggregate 无 orgId 时
   全局聚合 + deriveKpis() 无 org——跨租户执行事实聚合（§15/§16
   与 R-91 同类的聚合泄漏）；
3. **execution 读面**：GET /executions → executionList(query) →
   execution.service.list(query) 无 org 条件（listAll(orgId) 已有
   org 参数但 API 面未接线）；
4. **plan compare**：GET /plans/:planId/compare/:otherPlanId
   controller 不传 userContext——两个方案都经无守卫 getPlan 读取，
   跨租户方案对比泄漏（ADR-071 已建守卫但未接线）；
5. **policy versions**：listVersions() 读全租户策略版本行（RLS
   有 policy 兜底，应用层无 org 条件）；
6. **policy activations org 参数欺骗**：GET /policy/activations
   以 **query 参数 orgId** 过滤——任意租户可传任意 orgId 读取他租户
   激活台账（org 来源错误：应取自 ctx 而非请求参数）。

## 仓库事实

- ewoh_scheduling_conflict.org_id（1890）；无 RLS；写路径已 ctx
  注入 orgId（insertRow ctx.primaryOrgId）；
- ewoh_scheduling_feedback.org_id + RLS scheduler_feedback_org_
  isolation（025 policy 7）；list/deriveKpis 无 org 条件；
- ewoh_scheduling_execution.org_id（listAll(orgId) 已支持）；
- ewoh_scheduling_policy.org_id + RLS scheduler_policy_org_
  isolation（025 policy 6）；listVersions 无 org 条件；
- ewoh_policy_activation.org_id；listActivations(orgId?) 的 orgId
  来自 query 参数（可欺骗）。

## §29 十八问（实现前作答）

1. **Domain**：Scheduler 读面/聚合面（conflict/feedback/kpi/
   execution/compare/policy）。
2. **Canonical Contract**：无契约变更（additive 可选参数）。
3. **Authoritative Source**：各表 org_id；activation/conflict/
   feedback 行归属由写路径 ctx 注入（同一事实）。
4. **如何改变 Factory World**：零改变（读面过滤/拒绝）。
5. **Event**：无。
6. **谁消费**：调度 API、KPI 控制台、metrics 端点。
7. **失败会怎样**：跨租户 → 空结果/过滤（读面语义与 RLS 对齐，
   不泄露存在性）。
8. **离线会怎样**：云侧；无外部依赖。
9. **重复消息会怎样**：纯判定，幂等。
10. **权限边界**：org 匹配放行；无角色差异（与 RLS 对齐）。
11. **租户边界**：org 条件 = org 匹配或 NULL 存量放行
    （standalone_025 过渡边界）；activations org 取自 ctx（query
    参数来源废弃）。
12. **安全风险**：六条跨租户读/聚合泄漏路径闭合；org 参数欺骗
    修复。
13. **Human Approval**：不涉及（纯读面）。
14. **如何解释 Decision**：访问控制，非调度决策。
15. **如何测试**：SQL org 条件节点断言（conflict/feedback/
    execution/policy）+ deriveKpis org 过滤行为 + activation org
    来源 ctx 断言 + compare 守卫透传断言。
16. **如何审计**：拒绝/过滤路径无审计（与 R-92/R-93 同语义）。
17. **如何迁移**：无 DB 变更；纯应用层收敛。
18. **如何回滚**：还原签名与条件即回滚。

## 决策

### 决策 1：conflict 读面 org 作用域

listConflicts(params, actor?)/getConflictDetail(id, actor?)：
loadAllRows/findRowByConflictId 追加 org 条件（org 匹配或 NULL
存量）；推导态冲突由本租户世界状态快照产生（org 局部），无需
额外过滤。kpi 聚合冲突计数以本租户 actor 调用（聚合不混租户）。

### 决策 2：feedback list/deriveKpis org 作用域

list(orgId?)/deriveKpis(orgId?)：SQL org 条件（org 匹配或 NULL
存量）；metrics controller GET /feedback 与 /feedback/rows 注入
userContext；kpi.aggregate 将 opts.orgId 传入 deriveKpis。
orgId 缺省（内部调用）保持现状（RLS 兜底 + 显式文档化）。

### 决策 3：execution API 面 org 接线

queryService.executionList(query, actor?) → execution.service
.list(query, orgId?)（与 listAll(orgId) 同语义）；facade +
controller GET /executions 注入 userContext。

### 决策 4：compare 与 policy 读面接线

- GET /plans/:planId/compare/:otherPlanId 注入 userContext，
  两个方案读取都经 ADR-071 getPlan 守卫；
- listVersions(orgId?) 追加 org 条件（org 匹配或 NULL 存量）；
  controller GET /policy/versions 注入 userContext。

### 决策 5：activation org 来源修复

listActivations 的 org 改自 ctx.primaryOrgId（query 参数 orgId
废弃——org 事实只允许来自认证上下文，§3/§15）；controller 注入
userContext。

## 后果

- 调度域读面/聚合面组织隔离第三波闭合（conflict 无 RLS 的应用层
  唯一执行面显式声明）；
- 无 DB/契约/OpenAPI 变更；org 参数欺骗路径消除。
