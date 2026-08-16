# ADR-081：resource.service 完整 drizzle 化 + 语义假库（NO-13af）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-078（决策 2 遗留债务）、ADR-079（决策 4 列 NO-13ae/13af）、§3/§15/§30/§31

## 背景

resource.service 是 server 侧最后一个 raw-SQL 模块（12 处
ewoh_resource_preorder / ewoh_resource_binding 无前缀 SQL）。预占/
发行/冲减语义被 FakeSqlDb 正则假库场景锁定（ADR-078 去前缀过渡
态）。R-102 收口：新增 ewohResourcePreorder drizzle 映射、服务
全量链式重写、§31 语义假库替换正则假库。

## 仓库事实

- ewoh_resource_preorder：DB 表已存在（001 managed，org_id uuid
  NOT NULL GUC default，UNIQUE (org_id, resource_id, target_id,
  binding_type) 在 binding 表），但 TS schema.ts 无映射——
  NO-13af 补映射；
- ewoh_resource_binding：映射已有（numeric(18,4) quantity，
  orgId nullable varchar）；
- 预占扣减权威 = 条件更新（quantity >= issueQty 守卫零行即拒绝）
  + 进程内 resourceLocks 串行；
- 读取通过全局唯一 preorder_id / resource_id（读面 org 守卫
  未实现，列 NO-13ag）。

## §29 十八问（实现前作答）

1. **Domain**：资源预占/发行/释放（§4 Canonical Resource
   Model 侧）。
2. **Canonical Contract**：无变更（行为等价；写入新增 orgId 注入）。
3. **Authoritative Source**：ewoh_resource_binding
   （binding_type='inventory'）为库存事实层；preorder 为预占事实。
4. **如何改变 Factory World**：仅持久化 API 形态变化；行事实不变。
5. **Event**：无（既有 audit 面不变）。
6. **谁消费**：resource.controller + 场景 SP-02。
7. **失败会怎样**：safeExecute 包装保留 InternalServerErrorException。
8. **离线会怎样**：云侧。
9. **重复消息会怎样**：onConflictDoUpdate 种子 upsert 幂等；
   预占 id 时间戳序列唯一。
10. **权限边界**：不变（controller 鉴权面）。
11. **租户边界**：写入携带 actor primaryOrgId（ADR-075/076
    闭合对齐；缺省走 DB GUC default）；读面 org 守卫列 NO-13ag。
12. **安全风险**：无新增（无安全闭环迁移）。
13. **Human Approval**：不涉及。
14. **如何解释 Decision**：非调度决策。
15. **如何测试**：§31 单一助手 fake-resource-db.ts（语义假库：
    insert/returning/onConflictDoUpdate/select where/update set
    where 全链；AST 结构遍历提取 =/in/>= 事实与相对 +/- 补丁求值）
    ——resource spec 15 例 + SP-02 共用；FakeSqlDb 正则假库零用户
    后移除。
16. **如何审计**：resource.preorder/issue/release 审计不变。
17. **如何迁移**：无 DDL（映射补 TS 侧；managed_count 不变 74）。
18. **如何回滚**：还原 ADR-078 去前缀 raw SQL（行为等价）。

## 决策

### 决策 1：schema.ts 补 ewohResourcePreorder 映射

全列对齐 001 DDL（quantity/reserved_qty/issued_qty/consumed_qty/
returned_qty numeric(18,4)、unit/batch_no/task_id/task_step_id、
status/priority/start_time/end_time + 审计四列 + orgId nullable
varchar 仓库惯例）+ idx org / org+status；别名
ewohResourcePreorderTable。

### 决策 2：服务全量 drizzle 链式重写（12 处 → 0）

createPreorder（insert returning 别名）/issue（条件扣减 update
returning + 预占 update + issue binding insert）/release（返还
update returning + 无行回退 insert + 预占 update + release
binding insert）/getPreorder（select where limit 隐式一）/active
preorders（inArray pending,issued）/inventory quantity（select
limit 1）/种子库存（insert onConflictDoUpdate target
[orgId, resourceId, targetId, bindingType]）。numeric 列值以
sql`` 包裹（列 dataType string，避免 TS 字面量越型）。

### 决策 3：写入 orgId 注入（ADR-075/076 闭合）

四类 binding/preorder 写入携带 `actor?.primaryOrgId` 条件展开；
缺省（系统/无上下文）保持 DB GUC default 语义。

### 决策 4：§31 语义假库 fake-resource-db.ts 取代 FakeSqlDb

drizzle AST 含循环引用（列→表→列），禁 JSON 序列化——直接遍历
queryChunks：列对象（name）→ {value:[op]} → 右操作数（标量/
参数 {value}/in 数组/嵌套 SQL）；update 补丁求值区分绝对标量与
相对 `col - n` / `col + n`；gte 守卫（条件更新零行）由假库真实
语义承担——服务“零行即拒绝”防御分支的权威在假库级验证。
FakeSqlDb（正则、schema 可选）零用户，删除。

### 决策 5：读面 org 守卫列 NO-13ag

getPreorder/loadActivePreorders/loadInventoryQuantity 仍按全局
唯一 id 定位（与 ADR-078 语义一致，不回归）；actor org 过滤读面
列为下一候选（NO-13ag），与 ewoh_audit_log 认证读策略
（standalone_057）同波评估。

## 后果

- server raw-SQL 模块清零（resource 12 处 → 0；全仓 public.
  ewoh_ 保持 0）；
- §31 助手矩阵 +1（fake-resource-db.ts 语义假库），正则
  FakeSqlDb 退役；
- 无 DB 迁移/契约/OpenAPI 变更；写入 org 闭合加深一层。
