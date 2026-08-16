# ADR-077：控制面持久化修复（schema 硬编码 + org 归属，NO-13ab）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-075/076（受管表映射漂移闭合）、§2（supervisory 边界）/
  §3/§15/§30

## 背景

NO-13ab 仓库事实扫描（R-98）复核控制面（ewoh_control_request /
command / result——§2 监督式设备指令域），发现三类真实缺陷：

1. **schema 硬编码**：control.service 全部持久化走 raw SQL
   `insert into public.ewoh_control_*`——只在 standalone 部署
   （schema=public）成立；workspace 部署（__EWOH_SCHEMA__）中
   public.ewoh_control_request 不存在 → 控制面在真实部署潜伏
   不可用（CR-* CI 从未实证同源）；
2. **无 drizzle 映射**：三表在 schema-manifest/001 中为受管表
   （org_id uuid NOT NULL DEFAULT current GUC），但 schema.ts 完全
   未映射——应用无法用类型安全的 DRIZZLE_DATABASE 路径读写；
3. **org 归属缺口**：raw SQL 插入不含 org_id（依赖 DB 侧 GUC
   default；GUC 未设置时 default=NULL → NOT NULL 违反 fail
   closed）；读面 getRequest/findByIdempotencyKey 无 org 守卫——
   知道 requestId 即可读他租户控制请求（设备指令属于工厂私有
   操作事实，§15/§16）。

## 仓库事实

- 001 DDL：三表 org_id uuid NOT NULL DEFAULT
  (nullif(current_setting('app.current_org_id', true),'')::uuid)；
  command 表 UNIQUE (org_id, root_command_id, attempt_no,
  command_key)；
- control.controller：create/send/revoke 已注入 userContext；
  GET :id 与 POST :id/receipts 未注入；
- control.service：raw SQL + `public.` 硬编码 + execute()；
  无 drizzle 引用。

## §29 十八问（实现前作答）

1. **Domain**：控制面（§2 监督式设备指令——EWOH 只下发高级
   指令，实时安全闭环在设备侧）。
2. **Canonical Contract**：ControlRequest additive += orgId？
   （读回 org 归属事实；行为语义不变）。
3. **Authoritative Source**：行 org_id（物理列）；写侧 org =
   ctx.primaryOrgId（缺省时省略列由 DB GUC default 填充——
   GUC 空则 NOT NULL 显式失败，§33 不伪造）。
4. **如何改变 Factory World**：控制指令台账（创建/下发/回执/
   撤销）——本就不改变实时控制闭环（§2 边界不变）。
5. **Event**：无新事件（既有 audit 面不变）。
6. **谁消费**：网关回执/操作台查询。
7. **失败会怎样**：schema 硬编码修复 → 部署可用；org 缺失 →
   NOT NULL 显式失败（fail-closed）。
8. **离线会怎样**：云侧台账；网关侧语义不变。
9. **重复消息会怎样**：idempotency_key 幂等回读不变。
10. **权限边界**：读面 org 守卫（org 匹配放行；NULL legacy
    放行——与 R-92 语义对齐）。
11. **租户边界**：写侧 ctx 注入 + 读面守卫 + DB RLS
    （ewoh_org_visible）三层。
12. **安全风险**：设备指令台账跨租户读闭合（§16 私有操作数据）。
13. **Human Approval**：控制请求语义不变（requires_secondary_
    confirm 列物理存在；v1 不改变审批流）。
14. **如何解释 Decision**：非调度决策。
15. **如何测试**：control.service.spec 重写为 drizzle capture
    harness（insert/select/update 断言 orgId 注入 + 读面守卫
    404）+ legacy-org-id-mapping.spec 补 3 控制表映射锁定。
16. **如何审计**：既有 recordAudit 面不变（actor orgId 已带）。
17. **如何迁移**：无 DDL（物理列已存在）；纯应用层收敛
    （raw SQL → drizzle + 守卫）。
18. **如何回滚**：还原 raw SQL 实现即回滚（行为等价，除 schema
    硬编码修复与 org 守卫——回滚即重新引入缺陷，显式声明）。

## 决策

### 决策 1：三表 drizzle 映射

schema.ts 新增 ewohControlRequest / ewohControlCommand /
ewohControlResult 映射（列与 001 DDL 对齐；jsonb 承载
command_keys/response_json/result_json/payload；不映射
user_profile 系统列——插入省略，DB default 生效）。

### 决策 2：raw SQL → drizzle 重写

control.service 持久化路径全部改用 DRIZZLE_DATABASE 类型安全
链路（insert/select/update + returning），消除 `public.` 硬编码
（连接自身 schema 语义，workspace/standalone 双部署成立）。

### 决策 3：org 归属与读面守卫

- 写侧：orgId = actor?.primaryOrgId；actor 缺失时省略列（DB
  GUC default；GUC 空 → NOT NULL 显式失败，fail-closed）；
- 命令/回执行归属 = 请求行 org（§3 单一事实源——请求归属为准，
  非操作者）；
- 读面：getRequest(requestId, actor?) / getStatus(id, actor?) /
  findByIdempotencyKey(key, actor?) 经 assertTenantVisible
  （org 匹配或 NULL legacy 放行，跨租户 404）；controller GET
  :id 注入 userContext；receipts 网关路径无 ctx → 请求行 org
  派生（无守卫，网关通道语义不变）。

### 决策 4：契约 additive

ControlRequest += orgId?: string | null（读回归属事实，§3
Factory Truth）。

## 后果

- 控制面在 workspace 部署恢复可用 + 跨租户读闭合 + 类型安全；
- 无 DB 迁移；OpenAPI 不变（ControlRequest 非独立路由 schema
  源，类型 additive）。
