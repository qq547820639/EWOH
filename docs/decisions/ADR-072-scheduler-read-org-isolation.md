# ADR-072：Scheduler 读面组织隔离第二波（run/audit/constraint/decision-history，NO-13w）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-071（方案行组织隔离闭环）、ADR-004（RLS 三分类）、
  standalone_025、ADR-065（决策历史跨 kind 检索）、§15/§3/§33

## 背景

NO-13w 仓库事实扫描（R-93）在 ADR-071 收口方案行之后，复核调度
域其余读面，发现四类残留缺口：

1. **getRun(runId)**：ewoh_scheduling_run 有 org_id + RLS
   （scheduler_run_org_isolation），但应用层读面无守卫（完全依赖
   RLS 单层）；
2. **getAudit(planId?)**：ewoh_schedule_audit **无 org_id 列、
   无 RLS**——audit 行只挂 planId；无 planId 时全表返回、有 planId
   时可读任意租户方案审计——真实跨租户审计读泄漏；
3. **listPlanConstraints(planId)**：ewoh_scheduling_constraint 有
   org_id + RLS（023），但应用层读面无 org 条件（防御纵深缺失）；
4. **decision-history 方案来源查询**：`select decisionRecordsJson
   from ewoh_schedule_plan where isNotNull(...)` 读取**全部租户**
   方案行，仅靠记录级 `tenantId` 过滤——且注释仍声称"plan 表无
   org_id 列"（与 R-92 相同的过时注释类问题）。

## 仓库事实

- ewoh_scheduling_run.org_id（1188，RLS 025 policy 3）；
- ewoh_schedule_audit：无 org 列、无 RLS；行含 planId 外键事实
  （audit.planId → plan.planId），audit 行归属可由父方案事实推导；
- ewoh_scheduling_constraint.org_id（1266，RLS 023 policy）；
- decision-history.listDecisions 已注入 primaryOrgId（controller
  侧），三表已 SQL org 过滤，方案来源为唯一例外；
- R-92 守卫 plan-tenant-guard.ts 语义 = org 匹配或 NULL 存量放行、
  跨租户 404 反枚举。

## §29 十八问（实现前作答）

1. **Domain**：Scheduler 读面（run/audit/constraint/decision
   history）。
2. **Canonical Contract**：无契约变更（读面守卫 + SQL 条件）。
3. **Authoritative Source**：run/constraint 行 org_id；audit 归属
   = 父方案 org_id（单一推导，不新建事实列）。
4. **如何改变 Factory World**：零改变（纯读面过滤/拒绝）。
5. **Event**：无。
6. **谁消费**：调度 API 与 Decision History 控制台。
7. **失败会怎样**：跨租户 → 404（run）或空结果（audit/constraint/
   decision history 过滤）——与 RLS 语义对齐，不泄露存在性。
8. **离线会怎样**：云侧；无外部依赖。
9. **重复消息会怎样**：纯判定，幂等。
10. **权限边界**：org 匹配放行；无角色差异（与 RLS 对齐）。
11. **租户边界**：守卫/SQL 条件 = org 匹配或 NULL 存量放行
    （standalone_025 过渡边界逐字对齐）；audit 归属经父方案推导。
12. **安全风险**：跨租户审计读泄漏闭合（audit 无 RLS 是唯一
    完全依赖应用层的表——本 ADR 显式声明）。
13. **Human Approval**：不涉及。
14. **如何解释 Decision**：访问控制，非调度决策。
15. **如何测试**：守卫纯函数 + getRun/getAudit/constraint SQL
    条件节点断言 + decision-history 方案来源 org 条件断言 +
    跨租户行为测试。
16. **如何审计**：拒绝路径无审计（与 R-92 同语义）；audit 表自身
    读取现在 org 作用域。
17. **如何迁移**：无 DB 变更；纯应用层收敛。
18. **如何回滚**：还原签名与条件即回滚。

## 决策

### 决策 1：守卫泛化（§31 单一实现）

plan-tenant-guard.ts 增补 `assertTenantVisible(orgId, actor,
subjectLabel?)` 为唯一实现；`assertPlanTenantVisible` 保留为
同签名别名（R-92 调用点不变）。run/constraint/audit 语义复用
同一函数。

### 决策 2：getRun/getAudit/getPlanConstraints 应用层 org 闭合

- getRun(runId, actor?)：行读取后 assertTenantVisible（NULL 存量
  放行，跨租户 404）；
- getAudit(planId?, actor?)：actor 提供时审计行按父方案可见性
  过滤——`planId IN (SELECT planId FROM ewoh_schedule_plan WHERE
  org_id IS NULL OR org_id = :org)`（归属由父方案事实推导，§3
  单一事实源，不为 audit 表新建 org 列）；
- listPlanConstraints(planId, actor?)：constraint 行 org 条件
  （org 匹配或 NULL 存量）。
- controller GET runs/:runId、GET audit、GET
  plans/:planId/constraints 注入 request.userContext。

### 决策 3：decision-history 方案来源 SQL org 条件

listDecisions 方案来源查询在 isNotNull 条件之外追加
`org_id IS NULL OR org_id = tenantId`（orgId 缺失时保持现状）；
记录级 tenantId 过滤保留为第二层（纵深，§15）。修正过时注释。

### 决策 4：边界声明

- ewoh_schedule_audit 无 RLS 是本 ADR 显式声明的已知边界：归属
  经父方案推导过滤（应用层唯一执行面）；若未来 audit 直查面扩大，
  优先给 audit 表补 org_id + RLS（候选 standalone_056，不与本轮
  绑定）。
- NULL=全局/存量行语义与 standalone_025 对齐（不放宽不收紧）。

## 后果

- 调度读面（plan/run/audit/constraint/decision history）应用层
  org 闭合 + RLS 双层一致；audit 跨租户读泄漏闭合；
- 无 DB/契约/OpenAPI 变更；守卫 §31 单一实现泛化（R-92 行为不变）。
