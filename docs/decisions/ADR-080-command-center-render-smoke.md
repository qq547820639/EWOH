# ADR-080：CommandCenter 数据型页面渲染 smoke（NO-13ae）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-055（渲染测试补强）/ADR-068（SimulationConsole 渲染
  smoke，R-89 模式）、§17（Factory Operating Console）/§33

## 背景

NO-13ae 双候选（resource.service 完整 drizzle 化 vs 数据型页面
渲染 smoke）。resource 的 fake 需要复刻预占/发行/冲减语义（
FakeSqlDb 深度锁定），列 NO-13af 独立立项；R-101 选数据型页面
渲染 smoke——CommandCenter（指挥中心，§17 核心态势总览页）是
无任何逻辑/渲染测试的数据页，且页面内 KPI 派生与时间戳格式化
逻辑不可测。

## 仓库事实

- CommandCenter.tsx：121 行，useQuery（getOverview + getEvents(6)）
  + 内联 KPI 派生（六项，缺省 0）+ 事件列表（title||eventCode、
  `deviceId · severity · status`、createdAt toLocaleString）；
- R-87/R-89 既有模式：纯展示组件（SimulationRunList/
  DecisionHistoryTable）+ 纯逻辑模块（node 测试）+ renderToStatic
  Markup 渲染 smoke（client jest 120 suites/970 tests 基线）。

## §29 十八问（实现前作答）

1. **Domain**：前端操作台（§17 指挥中心视角）。
2. **Canonical Contract**：OverviewStats/EventInfo（既有契约，
   无变更）。
3. **Authoritative Source**：getOverview/getEvents 后端数据
   （视图零网络，注入式）。
4. **如何改变 Factory World**：零改变（纯展示重构）。
5. **Event**：无。
6. **谁消费**：指挥中心页。
7. **失败会怎样**：QueryState 错误面不变（页壳保留）。
8. **离线会怎样**：查询态语义不变。
9. **重复消息会怎样**：不涉及。
10. **权限边界**：不变。
11. **租户边界**：后端数据已 org 作用域；视图不引入新读面。
12. **安全风险**：无。
13. **Human Approval**：不涉及。
14. **如何解释 Decision**：非调度决策。
15. **如何测试**：commandCenterLogic.test.ts（KPI 派生/缺省 0/
    副标题/时间戳）+ CommandCenterView.render.test.tsx（渲染
    smoke）。
16. **如何审计**：不涉及。
17. **如何迁移**：无（纯前端重构）。
18. **如何回滚**：还原内联实现即回滚。

## 决策

### 决策 1：纯逻辑层 + 纯展示视图分离（R-89 模式）

- commandCenterLogic.ts：buildCommandCenterKpis（六项 KPI 派生，
  缺省 0 显式）+ buildEventSubtitle + formatEventTimestamp
  （createdAt 缺失 → 空串显式，§33 不伪造时间）；
- CommandCenterView.tsx：纯展示（KPI 网格 + 事件列表，图标按
  key 映射不进逻辑层）；CommandCenter.tsx 页壳保留 React Query
  + QueryState，内部委托视图。

### 决策 2：resource.service drizzle 化列 NO-13af

预占/发行/冲减语义复刻成本高（FakeSqlDb 场景锁定），独立立项。

## 后果

- 指挥中心数据页获得逻辑测试 + 渲染 smoke（§17 消费面补强）；
- 无契约/DB/服务端变更。
