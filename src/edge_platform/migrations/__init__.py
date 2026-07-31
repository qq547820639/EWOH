"""EWOH 数据库迁移脚本（Task 14.2）。

每个迁移模块以 `vNNN_<描述>.py` 命名，提供：
- `VERSION`：版本号字符串（如 "001"）；
- `MIGRATION`：SQL 字符串（DDL/DML），必须幂等（CREATE TABLE IF NOT EXISTS /
  CREATE INDEX IF NOT EXISTS / INSERT OR IGNORE），可重复执行；
- `upgrade(db)`：在给定 sqlite3.Connection 上执行迁移，返回受影响行数（仅作记录）。

迁移编排约定（与本 stub 包对齐）：
- 单机保留 SQLite；正式试点迁移到独立数据库服务时由运维侧等价执行；
- 迁移脚本不删除旧表、不破坏旧数据；新表用 CREATE TABLE IF NOT EXISTS 追加；
- 迁移记录表 `schema_migrations` 由 `upgrade_all` 维护，避免重复执行（虽幂等，仍记录）。

纯 Python 标准库实现。
"""

from .v001_add_governance_tables import MIGRATION as V001_MIGRATION
from .v001_add_governance_tables import VERSION as V001_VERSION
from .v001_add_governance_tables import upgrade as v001_upgrade

__all__ = [
    "V001_VERSION",
    "V001_MIGRATION",
    "v001_upgrade",
    "upgrade_all",
    "list_migrations",
]

# 已注册迁移（按版本顺序）
_MIGRATIONS = [
    (V001_VERSION, V001_MIGRATION, v001_upgrade),
]

# 迁移记录表 DDL（与 stubs.SCHEMA 解耦，仅由 upgrade_all 维护）
_MIGRATION_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
"""


def _now_iso():
    from datetime import datetime
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


def list_migrations():
    """返回已注册迁移列表：[(version, sql), ...]。"""
    return [(v, sql) for v, sql, _ in _MIGRATIONS]


def upgrade_all(db):
    """对给定 sqlite3.Connection 顺序执行所有未应用的迁移。

    幂等：每条迁移脚本本身用 IF NOT EXISTS，且通过 schema_migrations 表避免重复标记。
    返回本次新应用的迁移版本列表。
    """
    import sqlite3
    if isinstance(db, str):
        db = sqlite3.connect(db)
        should_close = True
    else:
        should_close = False
    try:
        db.execute(_MIGRATION_TABLE_DDL)
        db.commit()
        applied = {r[0] for r in db.execute(
            "SELECT version FROM schema_migrations").fetchall()}
        newly = []
        for version, _sql, fn in _MIGRATIONS:
            if version in applied:
                continue
            fn(db)
            db.execute("INSERT OR IGNORE INTO schema_migrations (version, applied_at)"
                       " VALUES (?, ?)", (version, _now_iso()))
            db.commit()
            newly.append(version)
        return newly
    finally:
        if should_close:
            db.close()
