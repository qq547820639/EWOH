# ADR-079：剩余 raw-SQL 模块 drizzle 化（world-cursor/ark/erp，NO-13ad）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-078（schema 硬编码清零，决策 2 遗留债务）、§3/§15/§30

## 背景

ADR-078 决策 2 将 ark/erp/resource/world-cursor 的去前缀方案登记
为过渡债务。R-100 收口其中三个模块的完整 drizzle 化；resource.
service（12 处 preorder/binding raw SQL）因场景测试经 FakeSqlDb
深度锁定、涉及预占/发行/冲减语义，单独列 NO-13ae。

## 仓库事实

- world-cursor：ewoh_world_snapshot（ewohWorldSnapshotCursor 映射）
  与 ewoh_world_delta_log（映射）——applyUpsert/applyRemoval/
  getSnapshot/getDelta 9 处 raw SQL；seq 为 identity 列（读回
  bigint）；
- ark：ewoh_scheduler_config（映射，org_id uuid NOT NULL GUC
  default，UNIQUE (org_id, config_key)）——读配置 + upsert 写入
  （on conflict do update）；
- erp：findByEvidence 的 ewoh_event 证据查询（event_code +
  evidence_json->>key）。

## §29 十八问（实现前作答）

1. **Domain**：世界游标（§4 状态快照面）/Ark 配置面/ERP 证据
   查询（§3）。
2. **Canonical Contract**：无变更（行为等价）。
3. **Authoritative Source**：行事实不变（org_id/seq/版本列）。
4. **如何改变 Factory World**：零改变（等价重写）。
5. **Event**：无。
6. **谁消费**：世界快照消费者（cursor 协议）/AI 配置/ERP 幂等。
7. **失败会怎样**：错误语义不变（safeExecute 包装保留）。
8. **离线会怎样**：云侧；无外部依赖。
9. **重复消息会怎样**：幂等语义不变（upsert/cursor 协议）。
10. **权限边界**：不变。
11. **租户边界**：世界快照/配置已有 org_id 语义（DB GUC default/
    哨兵 org）；drizzle 化不改变。
12. **安全风险**：无新增。
13. **Human Approval**：不涉及。
14. **如何解释 Decision**：非调度决策。
15. **如何测试**：共享助手 fake-world-db.ts（§31 单一假库，
    世界游标 spec + SP-05 共用）+ erp spec drizzle 链适配。
16. **如何审计**：既有审计面不变。
17. **如何迁移**：无 DDL（映射已存在）。
18. **如何回滚**：还原 raw SQL（行为等价，回滚仅失去类型安全）。

## 决策

### 决策 1：world-cursor → drizzle

delta insert（snapshotVersion 用 sql 子查询 max）/snapshot
select（版本降序 limit 1）/delta 分页（gt seq 阈值）/
snapshot insert（payload JSON 对象、checksum）；seq identity 读回
由 DB 生成（insert 不提供）。

### 决策 2：ark → drizzle

读配置（configKey + orgId 哨兵 + updatedAt 降序）与 upsert
（onConflictDoUpdate target [orgId, configKey]）。

### 决策 3：erp → drizzle

findByEvidence：eq(eventCode) + sql JSON 路径条件 + limit 1。

### 决策 4：resource 列 NO-13ae

resource.service 预占/发行/冲减 raw SQL（已去前缀、行为被
FakeSqlDb 场景锁定）完整 drizzle 化单列下一波。

## 后果

- raw SQL 模块再收口三个；resource 为唯一遗留（显式登记）；
- 无 DB 迁移/契约/OpenAPI 变更。
