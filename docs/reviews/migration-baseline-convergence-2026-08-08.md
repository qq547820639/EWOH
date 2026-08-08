# 迁移双基线收敛说明（Batch 8.2）

> 制定日期：2026-08-08
> 结论：**standalone_001~010 为唯一事实源；001_ewoh_managed_tables 标记 deprecated（保留不回滚）**

---

## 一、现状

| 基线 | 文件 | 规模 | 状态 |
|------|------|------|------|
| **standalone 链（事实源）** | `standalone_001_schema.sql` ~ `standalone_010_scheduling_feedback.sql` | 001 约 88KB + 10 个增量 | 生产主路径（README 明示唯一事实源） |
| **legacy 链（deprecated）** | `001_ewoh_managed_tables.sql`（+ rollback） | 约 121KB | 与 standalone 重叠（同一批表） |

## 二、重叠分析

两张基线都定义：`ewoh_device / ewoh_personnel / ewoh_production_task / ewoh_scheduler_config / ewoh_spatial_entity / ewoh_telemetry / ewoh_event / ewoh_ai_suggestion / ...`（50+ 表）。

差异点：
- standalone 链：`public` schema + re-entrant（IF NOT EXISTS）+ RLS 动态白名单 + org_id 默认 GUC
- legacy 链：`__EWOH_SCHEMA__` 模板 schema + `__EWOH_SCHEMA__` 占位符（渲染时替换）

## 三、裁定

1. **standalone 链为唯一事实源**（与 README「Schema 唯一事实源为 db/migrations/standalone_*」一致）
2. **legacy 链标记 deprecated**：
   - 不删除（历史交付包/旧环境回滚可能需要）
   - 在文件头加 deprecated 声明注释
   - `db/runner/run_migrations.js` 保持支持 legacy（兼容旧部署），但新增迁移一律走 standalone 链
3. **新增迁移规则**：新表/新列只写 `standalone_0XX_*.sql` + 对应 rollback；legacy 链冻结

## 四、执行

- [x] 本文档记录裁定
- [ ] （下一迭代）001_ewoh_managed_tables.sql 头部加 deprecated 注释
- [ ] （下一迭代）verify 期望值改由 schema-manifest.yaml 派生（消除 run_migrations.js 硬编码表计数）
