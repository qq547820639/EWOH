# ADR-082：Scheduling 数据页渲染 smoke + 纯逻辑层（NO-13ah，§17/§33）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-080（CommandCenter 渲染 smoke）、ADR-081（resource drizzle 化）、§17/§33

## 背景

R-101（ADR-080）为 CommandCenter 数据型页面建立渲染 smoke 模式
（纯逻辑层 + 纯展示视图 + 渲染测试）。R-104 推广到 Scheduling
页面（§17 生产调度中心，624 行，调度方案列表/审批/下发/运行记录）。

## 仓库事实

- Scheduling.tsx（624 行）：纯逻辑函数（formatTime/isPendingStatus/
  isPlanStaleError/metrics 格式化/状态过滤/错误聚合）内联不可测；
  PlanCard 组件（142-307 行）为纯展示但未导出。
- 无 Scheduling 逻辑/渲染测试。
- SchedulingPlanV2.trigger.type 为 SchedulingTrigger 联合类型
  （13 类，TRIGGER_LABELS 常量映射）；metrics 为 SchedulingPlanMetrics
  （lateMinutes/walkingMeters/stationWaitMinutes/maxWorkload/
  changeCost，全 required number）。
- 状态过滤 'approved' 实际映射到 approved/dispatched/executing/
  completed 四态（非仅 approved）。

## §29 十八问（实现前作答）

1. **Domain**：调度（§8 调度中心态势总览页）。
2. **Canonical Contract**：SchedulingPlanV2 / SchedulingPlanMetrics /
   SchedulingTrigger（shared/scheduler.ts）。
3. **Authoritative Source**：React Query 缓存（服务端权威）。
4. **如何改变 Factory World**：零改变（纯前端消费面）。
5. **Event**：无。
6. **谁消费**：调度员/班组长。
7. **失败会怎样**：测试失败 = 逻辑回归。
8. **离线会怎样**：云侧。
9. **重复消息会怎样**：不涉及。
10. **权限边界**：不变。
11. **租户边界**：不变（前端消费面）。
12. **安全风险**：无新增。
13. **Human Approval**：不涉及。
14. **如何解释 Decision**：非调度决策。
15. **如何测试**：schedulingLogic.test.ts（21 例纯逻辑）+
    Scheduling.render.test.tsx（5 例 PlanCard 渲染 smoke）。
16. **如何审计**：不变。
17. **如何迁移**：无。
18. **如何回滚**：删除测试文件 + 取消 PlanCard 导出。

## 决策

### 决策 1：schedulingLogic.ts 纯逻辑层

从 Scheduling.tsx 提取 8 个纯函数 + 2 个常量：
- formatTime（zh-CN 时间格式化，null → '—'）
- isPendingStatus（draft/shadow 判定）
- isPlanStaleError（409 + PLAN_STALE 判定）
- buildPlanSubtitle（版本·触发类型·时间戳）
- buildMetricsSummary（延期/移动/等待/负荷格式化）
- filterPlansByStatus（三态过滤：all/pending=shadow+draft/approved=四态）
- aggregateMutationErrors（CLI-222 错误聚合）
- buildRunSubtitle（触发类型·时间·方案数）
- STATUS_FILTERS / TRIGGER_LABELS 常量

### 决策 2：PlanCard 导出 + 渲染 smoke

PlanCard 组件（纯展示，无内部状态）导出供渲染 smoke 测试；
Scheduling.render.test.tsx mock 全部 React Query/API/图标/Toast
依赖后用 renderToStaticMarkup 验证契约字段透出（方案名/id/
状态标签/触发类型/时间戳/指标/AI 解读/状态标签区分）。

## 后果

- §17 消费面补强（Scheduling 数据型页面第二项渲染 smoke）；
- schedulingLogic 21 例 + PlanCard 渲染 5 例 = +26 tests；
- 无契约/DB/OpenAPI 变更。
