"""备份与恢复（Task 34）。

提供 ``BackupManager``：SQLite 数据库的备份、恢复、完整性校验与备份列表。

- ``backup(db_path, output_path)``：复制 SQLite 文件到输出目录（带时间戳），
  同时导出关键表为 JSON 副本（与 .db 同名 .json）。
- ``restore(backup_path, db_path)``：从备份文件恢复数据库。
- ``verify(db_path)``：执行 ``PRAGMA integrity_check`` 校验完整性。
- ``list_backups(backup_dir)``：列出备份目录下的备份文件。

子模块：
- manager：``BackupManager`` 实现。

纯 Python 标准库（``shutil`` / ``json`` / ``sqlite3`` / ``os``）；零第三方依赖。
"""

from .manager import BackupManager

__all__ = ["BackupManager"]
