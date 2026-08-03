"""备份管理器（Task 34）。

``BackupManager`` 提供基于文件复制的 SQLite 备份与恢复，配合 JSON 副本与
``PRAGMA integrity_check`` 完整性校验，满足试点场景下的数据保护要求。

设计要点：
- 备份产物为一对同名文件：``ewoh_backup_<YYYYMMDD_HHMMSS>.db`` +
  ``ewoh_backup_<YYYYMMDD_HHMMSS>.json``；JSON 副本按表导出关键表行，
  便于在 SQLite 不可用时人工查阅与跨工具迁移。
- 恢复时以备份 .db 文件覆盖目标路径；目标存在则先删除再复制，避免脏数据残留。
- ``verify`` 执行 ``PRAGMA integrity_check``，返回 ``(ok: bool, message: str)``。
- ``list_backups`` 按文件名时间戳倒序返回备份 .db 路径列表（最新在前）。

纯 Python 标准库（``shutil`` / ``json`` / ``sqlite3`` / ``os`` / ``datetime``）。
"""

import json
import os
import shutil
import sqlite3
from datetime import datetime

# 备份文件名前缀与时间戳格式（list_backups 按此匹配）
_BACKUP_PREFIX = "ewoh_backup_"
_BACKUP_TS_FMT = "%Y%m%d_%H%M%S"


class BackupManager:
    """SQLite 数据库备份/恢复/校验/列表管理器。"""

    def __init__(self, key_tables=None):
        """初始化。

        :param key_tables: 备份时导出为 JSON 的关键表名列表；
            None 时自动查询 sqlite_master 导出全部用户表。
        """
        self._key_tables = list(key_tables) if key_tables else None

    # ---- 备份 ----
    def backup(self, db_path, output_path) -> str:
        """复制 SQLite 文件到输出目录（带时间戳），同时导出关键表为 JSON。

        :param db_path: 源 SQLite 数据库路径。
        :param output_path: 输出目录（不存在则创建）。
        :return: 生成的 .db 备份文件绝对路径（.json 副本同名替换扩展名）。
        :raises FileNotFoundError: 源数据库文件不存在。
        """
        db_path = os.fspath(db_path)
        output_path = os.fspath(output_path)
        if not os.path.isfile(db_path):
            raise FileNotFoundError(f"源数据库不存在: {db_path}")
        os.makedirs(output_path, exist_ok=True)
        ts = datetime.now().strftime(_BACKUP_TS_FMT)
        db_name = f"{_BACKUP_PREFIX}{ts}.db"
        json_name = f"{_BACKUP_PREFIX}{ts}.json"
        db_dest = os.path.join(output_path, db_name)
        json_dest = os.path.join(output_path, json_name)
        # 用 SQLite 的 backup API 做一致性复制（比 shutil.copyfile 更安全，
        # 保证事务边界；若源库不可打开则回退到文件复制）。
        if not self._sqlite_backup(db_path, db_dest):
            shutil.copyfile(db_path, db_dest)
        # 导出关键表为 JSON 副本
        tables_dump = self._dump_tables(db_path)
        manifest = {
            "backup_type": "ewoh_sqlite_backup",
            "backup_at": datetime.now().astimezone().isoformat(timespec="milliseconds"),
            "source_db": os.path.abspath(db_path),
            "backup_db": os.path.abspath(db_dest),
            "tables": tables_dump,
        }
        with open(json_dest, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2, default=str)
        return os.path.abspath(db_dest)

    @staticmethod
    def _sqlite_backup(src, dst) -> bool:
        """用 sqlite3.Connection.backup() 复制数据库；失败返回 False。"""
        try:
            src_conn = sqlite3.connect(src)
            dst_conn = sqlite3.connect(dst)
            try:
                src_conn.backup(dst_conn)
            finally:
                dst_conn.close()
                src_conn.close()
            return True
        except sqlite3.Error:
            # 源库损坏或不可读 → 回退到文件复制
            return False

    def _dump_tables(self, db_path) -> dict:
        """导出关键表为 {table_name: [row_dict, ...]}。"""
        tables = self._key_tables
        result = {}
        try:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            try:
                if tables is None:
                    cur = conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
                    )
                    tables = [r[0] for r in cur.fetchall()]
                for t in tables or []:
                    try:
                        rows = conn.execute(f"SELECT * FROM {t}").fetchall()  # nosec B608 - table names from sqlite_master
                    except sqlite3.Error:
                        continue
                    result[t] = [dict(r) for r in rows]
            finally:
                conn.close()
        except sqlite3.Error:
            pass
        return result

    # ---- 恢复 ----
    def restore(self, backup_path, db_path) -> str:
        """从备份 .db 文件恢复到目标路径。

        :param backup_path: 备份 .db 文件路径。
        :param db_path: 恢复目标路径（存在则先删除）。
        :return: 恢复后的数据库绝对路径。
        :raises FileNotFoundError: 备份文件不存在。
        """
        backup_path = os.fspath(backup_path)
        db_path = os.fspath(db_path)
        if not os.path.isfile(backup_path):
            raise FileNotFoundError(f"备份文件不存在: {backup_path}")
        parent = os.path.dirname(os.path.abspath(db_path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        if os.path.exists(db_path):
            os.remove(db_path)
        shutil.copyfile(backup_path, db_path)
        return os.path.abspath(db_path)

    # ---- 校验 ----
    @staticmethod
    def verify(db_path) -> tuple[bool, str]:
        """执行 ``PRAGMA integrity_check`` 校验数据库完整性。

        :return: ``(ok, message)``；ok 为 True 时 message 为 "ok"。
        :raises FileNotFoundError: 数据库文件不存在。
        """
        db_path = os.fspath(db_path)
        if not os.path.isfile(db_path):
            raise FileNotFoundError(f"数据库不存在: {db_path}")
        try:
            conn = sqlite3.connect(db_path)
            try:
                cur = conn.execute("PRAGMA integrity_check")
                row = cur.fetchone()
                message = row[0] if row else "empty"
            finally:
                conn.close()
        except sqlite3.Error as e:
            return False, str(e)
        return (message == "ok"), message

    # ---- 列表 ----
    @staticmethod
    def list_backups(backup_dir) -> list[str]:
        """列出备份目录下的备份 .db 文件，按文件名时间戳倒序（最新在前）。"""
        backup_dir = os.fspath(backup_dir)
        if not os.path.isdir(backup_dir):
            return []
        items = []
        for name in os.listdir(backup_dir):
            if name.startswith(_BACKUP_PREFIX) and name.endswith(".db"):
                items.append(os.path.join(backup_dir, name))
        # 按文件名时间戳倒序（文件名即 ewoh_backup_<ts>.db）
        items.sort(reverse=True)
        return items


__all__ = ["BackupManager"]
