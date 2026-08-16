# ADR-071：方案行组织隔离闭环（应用层守卫 + 读模型归属透出，NO-13v）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-004（调度多租户 RLS 三分类）、standalone_025（RLS +
  ewoh_schedule_plan.org_id 补齐）、§15（多租户）/§3（Factory
  Truth）/§33

## 背景

NO-13v 仓库事实扫描（R-92）复核 ewoh_schedule_plan 的租户边界，
发现此前认知有误 + 三类真实缺口：

1. **认知修正**：standalone_025 已为 ewoh_schedule_plan 补齐
   org_id 列并建立 RLS policy（org 匹配或 NULL 放行）；persistPlan
   已写入 `orgId: ctx.primaryOrgId || null`。此前"方案表无 org 列"
   的认知是过时的（replan-coordinator 内还留着该过时注释，见下）。
2. **应用层守卫缺失**：getPlan / getPlanDetail / getPlans /
   getActivePlans 读面与 approvePlan / rejectPlan / dispatchPlan /
   replan / confirmPlan（legacy）/ applyOverrides / previewOverrides
   变面均无 org 匹配守卫——完全依赖 RLS。§15 明确要求核心数据不
   能只靠单一层；且 RLS 的 `org_id IS NULL` 分支意味着任何一行漏写
   orgId 即变为全局行。
3. **真实跨租户事实污染**：
   - replan-coordinator.loadLatestPlanObjective 按全局
     createdAt 倒序取"最近方案"作为抑制门基线（注释还声称
     "ewohSchedulePlan 无 orgId 列"）——会把**他租户**方案的目标
     值当作本租户基线，影响 ReplanStabilityBudget 抑制判定；
   - gamification allocateResources / orchestrateTask 直接
     insert ewoh_schedule_plan 且不写 orgId——**新行持续以 NULL
     （全局）落库**，绕过 RLS 隔离（RLS WITH CHECK 的 NULL 分支
     放行 NULL 行插入）。

## 仓库事实

- ewoh_schedule_plan.org_id varchar(255)（standalone_025，
  schema.ts 已映射 orgId）；RLS policy USING/WITH CHECK =
  `org_id = current_org OR org_id IS NULL`；
- persistPlan / ewohSchedulingPlanAssignment insert 已写 orgId
  （唯一合规写路径）；gamification 两条直插路径不写（缺口）；
- getPlans/getActivePlans/getPlanDetail（query service）与
  getPlan/approvePlan/rejectPlan/dispatchPlan/replan（plan
  service）均无 org 守卫；controller GET /plans、GET
  /active-plans、GET /plans/:planId 不传 userContext；
- confirmPlan（scheduler-plan-application，legacy）/ applyOverrides
  读取方案行后无 org 匹配检查；
- replan 抑制门 loadLatestPlanObjective 全局取基线（跨租户污染）。

## §29 十八问（实现前作答）

1. **Domain**：Scheduler 方案生命周期（读/写/变面）。
2. **Canonical Contract**：SchedulingPlanV2（additive）——
   增补可选 `orgId` 读模型归属字段（§3 可追溯的租户归属事实）。
3. **Authoritative Source**：ewoh_schedule_plan.org_id（standalone_025
   RLS 与 persistPlan 写入的同一事实；应用层守卫以同一列为唯一判定）。
4. **如何改变 Factory World**：守卫拒绝 = 不改变；合规请求行为不变。
5. **Event**：无新事件（拒绝路径不产生工业事实）。
6. **谁消费**：SchedulingPlanV2 消费方（前端/重放/决策历史）。
7. **失败会怎样**：org 不匹配 → NotFoundException（反枚举，与缺失
   方案同语义）；守卫缺失（无 actor 的内部可信流）→ 不变（RLS 仍
   在 DB 层执行）。
8. **离线会怎样**：云侧；无外部依赖。
9. **重复消息会怎样**：守卫幂等（纯判定）；写侧 orgId 确定性。
10. **权限边界**：org 匹配即放行；不引入角色差异（与 RLS 语义
    对齐，避免双层策略漂移）。
11. **租户边界**：应用层守卫 = org 匹配放行 + NULL 存量行放行
    （与 standalone_025 RLS 分支**逐字对齐**——分层等价不发明第二
    套语义）；新行由 persistPlan/gamification 全部归属写入，NULL
    行随时间归零。
12. **安全风险**：跨租户读/变更/基线污染三条路径同时闭合。
13. **Human Approval**：approve/reject/dispatch 语义不变（人工
    决策门保持）。
14. **如何解释 Decision**：拒绝无解释（访问控制，非调度决策）。
15. **如何测试**：plan-org-isolation.spec（守卫纯函数 + getPlan/
    approve/reject/dispatch/replan 跨租户拒绝 + 同租户/NULL 存量
    放行 + orgId 读回）+ gamification spec（两条直插路径 orgId
    写入）+ query/facade actor 转发断言。
16. **如何审计**：persistPlan audit 已带 orgId；gamification 写
    audit 不变（plan 行 org_id 即归属事实）。
17. **如何迁移**：无 DB 变更（列/RLS 已存在）；纯应用层收敛 +
    §31 单一守卫实现。
18. **如何回滚**：还原 getPlan 等签名与守卫即回滚（契约字段
    additive 不破坏）。

## 决策

### 决策 1：单一守卫实现（§31）

新增 `server/modules/scheduler/plan-tenant-guard.ts` 导出纯函数
`assertPlanTenantVisible(planOrgId, actor, planId?)`：

- `actor == null` → 放行（内部可信流，RLS 继续兜底）；
- `planOrgId == null` → 放行（standalone_025 NULL=全局/存量行
  语义，与 RLS 分支对齐）；
- `planOrgId !== actor.primaryOrgId` → NotFoundException
  （`Plan ${planId} not found`，反枚举）。

所有调用点共用该实现，禁止内联重复判断。

### 决策 2：读面 + 变面全部接线 actor

- plan.service.getPlan(planId, actor?)：行读取后守卫；
  toPlanV2 透出 `orgId: plan.orgId`（读模型归属事实）；
- approvePlan / rejectPlan / dispatchPlan / replan：行读取后
  守卫（反枚举 404，先于业务校验）；
- scheduler-query.service：getPlans(status, actor?) 与
  getActivePlans(actor?) 在 SQL 层加 `or(isNull(orgId),
  eq(orgId, actor.primaryOrgId))`（防御纵深；RLS 等价语义）；
  getPlanDetail(planId, actor?) 透传；
- scheduler.service facade 与 controller（GET /plans、GET
  /active-plans、GET /plans/:planId）透传 request.userContext；
- scheduler-plan-application：confirmPlan（legacy）与
  applyOverrides 行读取后守卫；
- override-preview.preview：getPlan(planId, ctx) 透传（跨租户
  预览返回 404 与 getPlan 同语义）。

### 决策 3：replan 抑制门基线按 org 作用域

loadLatestPlanObjective(ctx) 按 `org_id = ctx.primaryOrgId OR
NULL` 过滤基线（修正过时注释）；shouldSuppressForLowImprovement
调用链透传 ctx。

### 决策 4：gamification 直插路径归属闭合

allocateResources / orchestrateTask 接受可选 actor，两处
ewoh_schedule_plan insert 写入 `orgId: actor?.primaryOrgId ??
null`；controller 两路由透传 request.userContext。写 org 行的
RLS WITH CHECK 由请求级 GUC（OrgContextInterceptor）满足；无
上下文路径（内部/测试）退 NULL 与 persistPlan 语义一致。

### 决策 5：边界声明

- NULL=全局/存量行是 standalone_025 既有过渡边界（RLS 放行），
  应用层守卫与之逐字对齐，不发明更严/更松的第二套语义；
- 跨租户行经守卫后与"不存在"同语义（404），不泄露存在性；
- 深层路径（run orchestrator 内部读取等）保持 RLS 兜底，不逐点
  加守卫（守卫针对 API 边界与跨租户事实污染点）。

## 后果

- 跨租户方案读/变更/基线污染三条路径闭合（机器强制 + 分层等价）；
- SchedulingPlanV2 additive 字段（orgId）→ OpenAPI/client 类型
  重生成，无破坏性变更；
- 无 DB 迁移（列与 RLS 已存在），无回滚链/CI 变更。
