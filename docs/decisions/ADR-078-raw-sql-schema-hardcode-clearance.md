# ADR-078：raw-SQL schema 硬编码清零 + 聚合面 org 条件（NO-13ac）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-077（控制面持久化修复，同缺陷类首例）、§3/§15/§16/§30

## 背景

NO-13ac 全仓库扫描（R-99）排查与 ADR-077 同源的 raw SQL
`public.ewoh_*` 硬编码缺陷类，发现 7 文件 30+ 处：

- tracing.service（trace_span 边界清理 + 三面缝合 event/audit_log）；
- audit.service（audit_log count/list）；
- learning.service（三个学习指标聚合：ai_suggestion/event/
  scheduling_feedback）；
- ai.service（suggestion 落库/读回/plan_content + 系统上下文聚合
  telemetry/event/production_task）；
- database-audit-sink / work-orchestration（ewoh_append_audit_log
  函数调用）；
- ark.service（scheduler_config 读写）、erp.service（event 证据
  查询）、resource.service（preorder/binding 12 处）、
  world-cursor.service（world_snapshot/delta_log 9 处）。

缺陷双面：1) `public.` 前缀只在 standalone 部署成立，workspace
部署潜伏不可用；2) 若干聚合面无 org 条件（learning 接受率/覆盖
率聚合、ai 上下文采集、ai snapshot-version）——跨租户事实混合
（§15/§16）。

## 仓库事实

- 连接无 search_path 显式配置（standalone postgres-js 缺省
  public；workspace 平台连接以 workspace schema 运行 RLS/GUC）；
  drizzle 生成无前缀表名——search_path 解析是双部署成立的唯一
  一致路径；
- ewoh_audit_log 无 drizzle 映射（本轮补齐）；
- 聚合面 org 过滤语义 = eq(org_id, orgId)（NULL legacy 行排除于
  租户聚合——NULL=全局行不属任何租户，§3）。

## §29 十八问（实现前作答）

1. **Domain**：持久化基础设施 + 学习/AI 聚合面（§3/§15/§16）。
2. **Canonical Contract**：AuditQuery += orgId?（additive）；
   无其余契约变更。
3. **Authoritative Source**：行 org_id（聚合过滤事实）。
4. **如何改变 Factory World**：零改变（路径/过滤等价重写）。
5. **Event**：无。
6. **谁消费**：审计查询/追踪缝合/学习指标/AI 上下文。
7. **失败会怎样**：行为等价（错误语义不变，§33 不吞异常）。
8. **离线会怎样**：云侧；无外部依赖。
9. **重复消息会怎样**：幂等（insert/update 语义不变）。
10. **权限边界**：org 过滤为数据面；角色语义不变。
11. **租户边界**：聚合面 org 条件（跨租户混合关闭）；审计查询
    可选 orgId。
12. **安全风险**：跨租户学习/AI 事实混合消除。
13. **Human Approval**：不涉及。
14. **如何解释 Decision**：非调度决策。
15. **如何测试**：ai/audit/learning/tracing/scenario 既有 spec
    适配（drizzle 链式假库）+ fake-sql-db 表名/列名正则 schema
    可选化。
16. **如何审计**：审计链本身不变（hash 链）。
17. **如何迁移**：无 DDL（纯应用层重写）。
18. **如何回滚**：还原 raw SQL（重新引入缺陷，显式声明）。

## 决策

### 决策 1：有映射表 → drizzle 全量重写

tracing（count/delete/缝合）、audit（count/list + ewohAuditLog
映射新增）、learning（三聚合）、ai（suggestion 全路径 + 上下文
聚合）——类型安全 + search_path 解析。

### 决策 2：无映射/大面 raw SQL → 前缀去硬编码

ark/erp/resource/world-cursor 与 ewoh_append_audit_log 函数调用：
去 `public.` 前缀（search_path 解析，双部署成立）；这些模块的
完整 drizzle 化列为后续债务（行为已由 FakeSqlDb 场景测试锁定）。

### 决策 3：聚合面 org 条件

learning 三聚合 + ai 上下文采集 + ai snapshot-version 按
orgId 过滤（eq 语义；无 ctx 调用点保持现状由 RLS 兜底，显式
文档化）；ai.controller chat/snapshot-version 注入 userContext。

## 后果

- `public.ewoh_` 在 server 代码清零（缺陷类闭合）；
- 学习/AI 跨租户聚合混合消除；
- 无 DB 迁移/OpenAPI 变更。
