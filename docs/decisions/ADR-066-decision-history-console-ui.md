# ADR-066：Decision History 控制台 UI（NO-13q）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-065（跨 kind 检索端点）、ADR-047（DecisionRecord 契约）、
  §17（Factory Operating Console）、§18（可解释性）、§33

## 背景

Decision History 读面已收口（ADR-065，GET /api/scheduler/decision-
history）。§17/§18 要求消费面闭环：决策历史控制台（数据型页面）——
操作员/值班长可在控制台检索 8 类 kind 决策记录（为什么/谁/何时/
风险档/依据），显式呈现非法记录计数（§33 不静默）。

## §29 十八问（实现前作答）

1. **Domain**：Decision History 消费面（§12/§18 UI）。
2. **Canonical Contract**：DecisionRecord（ADR-047）——客户端类型
   复用 @shared/decision（§31 单一实现，不重复定义）。
3. **Authoritative Source**：ADR-065 端点（服务端四表聚合为唯一
   读事实源；客户端零二次计算/零猜测）。
4. **如何改变 Factory World**：零改变（只读页面）。
5. **Event**：无。
6. **谁消费**：调度员/值班长/全局管理员（nav roles）。
7. **失败会怎样**：请求失败 → 显式错误态 + 重试按钮（不静默）；
   skippedInvalid > 0 → 显式横幅（§33）。
8. **离线会怎样**：页面错误态显式（无本地缓存语义）。
9. **重复消息会怎样**：react-query 幂等只读（无副作用）。
10. **权限边界**：roles dispatcher/workshop_lead/global_admin
    （与审批控制台同面）。
11. **租户边界**：请求由后端 ctx 注入 org（客户端不传租户）。
12. **安全风险**：无（只读）。
13. **Human Approval**：不适用（只读）。
14. **如何解释 Decision**：表格透出契约字段（kind/status/
    authority/riskLevel/subject/decidedAt/selected.reason/approver/
    evidence）——展示层不做二次解释（§18 解释来自真实记录）。
15. **如何测试**：decisionHistoryLogic 纯逻辑测试（标签/tone/行
    构建/风险档）+ DecisionHistoryTable 渲染 smoke
    （renderToStaticMarkup 数据行断言）+ 控制台渲染 smoke
    （QueryClientProvider 加载态）。
16. **如何审计**：只读页面无审计写。
17. **如何迁移**：无 DB/OpenAPI 变更（消费既有端点）。
18. **如何回滚**：删除路由 + nav 项 + 页面文件即回滚。

## 决策

### 决策 1：数据型页面 = 纯逻辑 + 纯展示 + 控制台三层

- `decisionHistoryLogic.ts`：KIND/STATUS/AUTHORITY 标签、风险档
  tone、buildDecisionRows（契约字段 → 行模型，未知值原样透出不
  猜测）；
- `DecisionHistoryTable.tsx`：纯展示组件（行模型 props，零网络）；
- `DecisionHistoryConsole.tsx`：react-query 消费端点 + kind/status
  过滤 + 分页 + skippedInvalid 显式横幅 + 错误/空/加载态。

### 决策 2：skippedInvalid 显式呈现（§33）

sources 计数与 skippedInvalid 在页面顶部显式呈现（非法记录绝不
静默消失）；未知 kind/status 词表值原样透出（不猜测标签）。

### 决策 3：无本地缓存语义 + 简单分页

分页 = limit 50 + "加载更多"（offset 追加），无客户端聚合/排序
（服务端排序为权威）。

## 后果

- 正：Decision History 消费面闭环（§17 数据型页面 + §18 可解释性
  展示面）；渲染 smoke 补强（数据型页面缺口关闭）。
- 负：无（只读页面）。
- 无破坏性变更（无 DB/OpenAPI/env 变更）。
