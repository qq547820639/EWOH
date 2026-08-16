# ADR-068：SimulationConsole 数据型页面渲染 smoke（NO-13s）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-036（仿真运行控制台）、ADR-066（决策历史控制台 UI——
  数据型页面 smoke 模式）、§17/§18/§31/§33

## 背景

R-87（ADR-066）建立了数据型页面渲染 smoke 模式：纯逻辑 + 纯展示
组件 + 渲染测试（renderToStaticMarkup 契约字段断言）。NO-13s 把该
模式推广到 SimulationConsole（ADR-036 台账列表面）——收口数据型
页面渲染 smoke 缺口的第二项。

## §29 十八问（实现前作答）

1. **Domain**：仿真控制台展示层（§17/§13 L6 消费面）。
2. **Canonical Contract**：SimulationRun 体系（ADR-025）——展示
   层不重算结果（既有边界不变）。
3. **Authoritative Source**：服务端台账（listSimulationRuns 唯一
   读事实源）；行模型由 buildRunListRows 纯函数构建。
4. **如何改变 Factory World**：零改变（展示层重构 + 测试）。
5. **Event**：无。
6. **谁消费**：操作员仿真控制台（既有角色不变）。
7. **失败会怎样**：失败行 failureReason 作为头条显式透出（§33
   不静默；既有语义保持）。
8. **离线会怎样**：不适用（纯展示组件零网络）。
9. **重复消息会怎样**：不适用（无副作用）。
10. **权限边界**：不涉及（纯展示组件无路由变更）。
11. **租户边界**：台账列表来自服务端租户作用域（既有）。
12. **安全风险**：无。
13. **Human Approval**：不适用。
14. **如何解释 Decision**：行模型头条 = 结果摘要/失败原因（展示
    层不做二次解释，既有 buildResultSummary 语义不变）。
15. **如何测试**：SimulationRunList.render.test 2 例（数据行契约
    字段透出 / 失败行显式头条 + aria-pressed 选中态）。
16. **如何审计**：不适用（只读展示）。
17. **如何迁移**：无 DB/OpenAPI/env 变更；TONE_TEXT/TONE_BORDER
    上移至 logic（§31 单一来源），控制台消费路径不变。
18. **如何回滚**：还原内联 ul 即回滚（行为逐字一致）。

## 决策

### 决策 1：提取 SimulationRunList 纯展示组件

台账列表从 SimulationConsole 提取为纯展示组件（rows/selectedRunId/
onSelectRun props，零网络）；控制台委托渲染（行为逐字一致，既有
data-testid 与类名保留）。

### 决策 2：TONE 常量上移 logic（§31 单一来源）

TONE_TEXT/TONE_BORDER 从控制台移至 simulationConsoleLogic（与
ConsoleTone 同源）；控制台与列表组件共用同一来源。

### 决策 3：渲染 smoke 按 R-87 模式

renderToStaticMarkup + 行模型注入 → 契约字段断言（runId/kind 标签/
状态标签/结果摘要头条/失败原因/aria-pressed）。

## 后果

- 正：数据型页面渲染 smoke 缺口第二项关闭（SimulationConsole 台账
  列表面）；§31 单一来源（TONE 常量）；展示层可测性提升。
- 负：无（纯展示重构，行为逐字一致）。
- 无破坏性变更（无 DB/OpenAPI/env 变更）。
