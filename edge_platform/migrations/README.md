# EWOH 数据库迁移机制

本目录承载 EWOH 受控试点系统的 SQL 迁移脚本，与 `edge_platform/edge/storage.py`
保持同构。脚本按文件名序号升序执行。

## 当前迁移版本

| 序号 | 文件 | 内容 |
|------|------|------|
| 001  | `001_initial.sql`                         | 初始建表：person / device / telemetry / inference / risk_event / raw_frame / audit_log / consent_record / device_protocol_version / event_handling / assignment / model_registry / rule_registry / schema_migrations，含核心索引 |
| 002  | `002_add_device_version_columns.sql`      | 为 telemetry 补充 `device_model` / `firmware_version` / `protocol_version` / `raw_ref` 列；为 device 补充 `device_model` / `protocol_version` 列 |

## 执行机制

### SQLite（默认，开发/单机）

`Storage.init_db()` 启动时自动执行：

1. `executescript(_SCHEMA)`：所有 `CREATE TABLE IF NOT EXISTS`，幂等。
2. `_migrate_columns("telemetry", ...)`：通过 `PRAGMA table_info(<table>)` 检查
   列是否存在，缺失则 `ALTER TABLE ... ADD COLUMN`。这一步是必须的，因为 SQLite
   的 `ALTER TABLE ADD COLUMN` 不支持 `IF NOT EXISTS` 语法。

调用 `Storage.apply_migrations(migrations_dir)` 可在初始化后按序执行本目录下
`*.sql` 脚本，已执行的版本记录在 `schema_migrations` 表中，重复执行会被跳过
（幂等保护）。返回 `{"applied": [...], "skipped": [...]}`：
- `applied`：本次成功执行的版本；
- `skipped`：脚本语法不兼容当前后端（如 SQLite 不支持 `ALTER TABLE ADD COLUMN
  IF NOT EXISTS`）时跳过——SQLite 路径下这些列迁移已由 `Storage._migrate_columns()`
  在 `init_db` 阶段处理，无需脚本介入；postgres 上脚本可正常执行。

单个脚本失败不中断后续脚本，便于运维按需补齐。SQLite 默认不开 `apply_migrations`
（`init_db` 已处理建表与列迁移），仅在显式需要时调用并自行处理 002 的语法兼容。

### PostgreSQL（试点可选后端）

阶段 2 提供 `EWOH_DB_BACKEND=postgres` + `EWOH_DB_URL` 占位（详见 `edge/storage.py`
的 `create_storage()` 工厂）：当前会抛 `StorageBackendUnavailable`，提示安装
`psycopg2` 或回退 sqlite。正式迁移到 postgres 时：

```bash
psql "$EWOH_DB_URL" -f migrations/001_initial.sql
psql "$EWOH_DB_URL" -f migrations/002_add_device_version_columns.sql
# 已执行版本可手动 INSERT INTO schema_migrations(version, applied_at)
# VALUES ('001_initial', NOW()), ('002_add_device_version_columns', NOW());
```

Postgres 9.6+ 支持 `ALTER TABLE ADD COLUMN IF NOT EXISTS`，002 脚本可安全重复执行。

## 备份与恢复

- `Storage.backup_db(dest_path)`：SQLite 路径下 `shutil.copy2` 复制 db 文件，
  调用前会 `PRAGMA wal_checkpoint(FULL)` 刷盘确保一致性。
- `Storage.restore_db(src_path)`：关闭当前连接 → 复制 src 覆盖 db_path →
  重开连接 → `init_db()`。
- Postgres 路径：阶段 2 仅占位（`NotImplementedError`），后续阶段补 `pg_dump` /
  `pg_restore` 调用。

## 数据保留与清理

- `Storage.retention_purge(retention_days, person_id=None)`：删除早于
  `now - retention_days` 的 telemetry / inference，**保留 risk_event 与 audit_log**
  （事件留痕与审计是合规底线）。当 `person_id` 提供时，按设备绑定人员过滤，
  专门用于授权撤回场景。
- `Storage.reset_demo()`：演示重置，清空非 `real` 来源的 telemetry / inference /
  risk_event / raw_frame 与设备在线状态；真实数据保留。
