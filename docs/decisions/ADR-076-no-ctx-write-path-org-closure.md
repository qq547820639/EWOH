# ADR-076：无 ctx 写路径 org 归属闭合（NO-13aa）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-075（Legacy 受管表 org_id 映射漂移闭合，决策 3 显式
  边界登记）、§3/§15/§30

## 背景

ADR-075 决策 3 登记了三处无认证上下文写路径保持 NULL org 并列入
NO-13aa 候选：sensor-ingest ingestEnvironment、organization.
createOrganization、dashboard.createDevice。R-97 逐路径复核并
闭合——NULL org 行在 001 ewoh_org_visible RLS 下对非 admin 请求
不可读/不可写（生产潜伏故障面），必须消除新行持续落 NULL。

## 仓库事实

- ingest POST /environment（ingest.controller）已有 userContext
  面（同文件其他路由注入 userContext；IngestService 有 ctx 语义）；
- organization.createOrganization 无 actor；ewoh_organization 行
  的归属语义 = 组织自身（org 树根/节点对其自身可见）；
- dashboard POST /devices（createDevice）无 actor 签名；同文件
  PATCH /devices/:deviceId 已注入 userContext。

## §29 十八问（实现前作答）

1. **Domain**：多租户数据面（§15）——环境/组织/设备写路径。
2. **Canonical Contract**：无契约变更（additive 可选参数）。
3. **Authoritative Source**：行 org_id（注入源 = 认证 ctx /
   组织自身 id / 认证 ctx）。
4. **如何改变 Factory World**：新行携带 org 归属；零语义变化。
5. **Event**：无。
6. **谁消费**：读面 RLS（ewoh_org_visible）。
7. **失败会怎样**：无 ctx → NULL 显式 legacy（不伪造 org，
   §33）。
8. **离线会怎样**：云侧；无外部依赖。
9. **重复消息会怎样**：幂等/upsert 不变。
10. **权限边界**：ctx org 注入；org 创建 = 自身 id（全局管理员
    操作语义不变）。
11. **租户边界**：三路径闭合；存量 NULL 行过渡边界不变。
12. **安全风险**：新行不再落 NULL（读回可见性恢复）。
13. **Human Approval**：不涉及。
14. **如何解释 Decision**：非调度决策。
15. **如何测试**：sensor-ingest orgId 注入/无 org NULL 两例；
    organization 行 id==orgId 断言。
16. **如何审计**：环境/设备行归属事实可追溯（org_id 列）。
17. **如何迁移**：无 DDL（列已存在）。
18. **如何回滚**：还原签名/注入即回滚。

## 决策

### 决策 1：sensor-ingest 环境行归属 = 认证 ctx org

ingest.controller POST /environment 注入 userContext →
ingestEnvironment(frame, orgId?) → 行 orgId = orgId ?? null
（无 ctx 显式 legacy）。

### 决策 2：organization 行归属 = 自身 id

createOrganization 应用侧确定性 UUID（randomUUID）同时作为 id
与 orgId——组织对自身可见（ewoh_org_visible 语义），§3 单一
事实源，无 CTE/回读复杂度。

### 决策 3：dashboard 设备行归属 = 认证 ctx org

createDevice(dto, actor?) + controller @Req 注入；
orgId = actor?.primaryOrgId ?? null。

## 后果

- ADR-075 决策 3 的三处显式边界全部闭合；NO-13aa 收口；
- 无 DB/契约/OpenAPI 变更。
