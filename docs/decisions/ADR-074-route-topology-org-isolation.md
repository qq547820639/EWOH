# ADR-074：路由拓扑组织隔离（standalone_056，NO-13y）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-071/072/073（读面组织隔离三波）、standalone_025（RLS
  模式）、§4（World Model 中枢）/§15（多租户）/§23（空间模型）

## 背景

NO-13y 仓库事实扫描（R-95）复核世界状态读面（§4 系统中枢事实层），
发现路由拓扑（ewoh_route_node / ewoh_route_edge）是中枢层唯一
无组织边界的读面：

- 两表无 org_id 列、无 RLS（不在 001 通用 ewoh_org_visible 循环
  列表，也不在 025 scheduler RLS 列表）；
- 读面：GET /api/scheduler/routes（routing.service.loadGraph）+
  WorldStateSnapshotService.collectState（GET /snapshot 与所有
  求解/重排快照路径的 routeStatus 组件）——全部租户共享同一张
  全局路由图，跨租户工厂布局事实泄漏；
- 写面：代码无直插写路径（种子 SQL 提供；行均为 NULL org）。

## 仓库事实

- ewoh_route_node / ewoh_route_edge：nodeId/edgeId 唯一，
  stationId/zoneId 挂接，坐标/距离/容量——工厂空间布局事实；
- 读者：routing.service.loadGraph（74/133/244 内部 +
  queryService.getRoutes）、collectState（world-state.service
  182-183 行）；
- 写者：无应用写路径（seed 阶段注入）。

## §29 十八问（实现前作答）

1. **Domain**：空间模型 / 路由图（§23；World Model 中枢组件 §4）。
2. **Canonical Contract**：RouteGraph 语义不变（additive 列）。
3. **Authoritative Source**：行 org_id（新增；NULL=存量全局过渡行，
   与 standalone_025 语义对齐）；写者未来写入时 ctx 注入。
4. **如何改变 Factory World**：读面过滤；零状态改变。
5. **Event**：无。
6. **谁消费**：调度求解/重排/地图。
7. **失败会怎样**：跨租户行在 RLS 层不可见（读面语义对齐）。
8. **离线会怎样**：云侧；无外部依赖。
9. **重复消息会怎样**：纯判定，幂等。
10. **权限边界**：org 匹配放行；无角色差异（与 025 对齐）。
11. **租户边界**：RLS（org 匹配或 NULL 存量放行）+ 应用层 org
    条件（防御纵深）；新行由未来写路径 ctx 注入归属。
12. **安全风险**：跨租户工厂布局事实泄漏闭合。
13. **Human Approval**：不涉及（纯读面）。
14. **如何解释 Decision**：访问控制，非调度决策。
15. **如何测试**：standalone_056 verify 自证（列存在 + RLS policy
    文本 + SET LOCAL GUC 可见性自证拒绝）+ routing org 条件
    单元测试。
16. **如何审计**：读面过滤无审计（与前几波同语义）。
17. **如何迁移**：standalone_056 原地加固（ADD COLUMN + ENABLE
    RLS + policy；managed_count/physical_create_count 不变
    74/77）；存量行 NULL 过渡放行，不触发行级改写。
18. **如何回滚**：DROP POLICY + DROP COLUMN（成对回滚链 + CI
    验证）。

## 决策

### 决策 1：路由表原地组织加固（standalone_056）

两表 ADD COLUMN org_id varchar(255)（NULL=存量全局过渡）+ ENABLE
RLS + policy `route_node_org_isolation` / `route_edge_org_
isolation`：USING/WITH CHECK = org 匹配（app.current_org_id，
回退 app.primary_org_id）或 org_id IS NULL——与 standalone_025
逐字对齐（不用 ewoh_org_visible：其 NULL 分支会隐藏存量全局行，
破坏种子/内部无 GUC 读取的过渡兼容）。

### 决策 2：读面应用层 org 条件

- routing.service.loadGraph(actor?)：actor 提供时两表 org 条件
  （isNull OR eq）；
- queryService.getRoutes(actor?)/facade/controller GET /routes
  注入 userContext；
- collectState 保持无 actor（内部调用面；RLS 为执行层，显式边界）。

### 决策 3：写面边界声明

当前无应用写路径；未来写路径必须 ctx 注入 orgId（RLS WITH CHECK
强制）。种子行 NULL 语义 = 部署级全局拓扑（过渡）。

## 后果

- World Model 中枢读面最后一块无组织边界组件闭合（§15/§23）；
- 无契约/OpenAPI 变更；原地加固计数不变（74/77）。
