#!/usr/bin/env python3
"""SQLite 数据库备份/恢复/校验命令行工具（Task 34）。

用法
----
  # 备份：复制 demo.db 到 backups/ 目录（带时间戳），同时导出关键表为 JSON
  python -m edge_platform.scripts.backup_db --action backup --db demo.db --output backups/

  # 恢复：从备份文件恢复到指定路径
  python -m edge_platform.scripts.backup_db --action restore \
      --backup backups/ewoh_backup_20260731_120000.db --db demo.db

  # 校验：执行 PRAGMA integrity_check
  python -m edge_platform.scripts.backup_db --action verify --db demo.db

  # 列出备份
  python -m edge_platform.scripts.backup_db --action list --output backups/

退出码：0 成功；2 参数错误；3 源/备份文件不存在；4 校验失败。
"""

import argparse
import os
import sys


def _ensure_path():
    """支持 python -m edge_platform.scripts.backup_db 与直接运行两种方式。"""
    here = os.path.dirname(os.path.abspath(__file__))
    src = os.path.dirname(os.path.dirname(here))  # src/
    if os.path.isdir(src) and src not in sys.path:
        sys.path.insert(0, src)


_ensure_path()

from edge_platform.backup import BackupManager  # noqa: E402


def _parse_args(argv):
    p = argparse.ArgumentParser(description="EWOH SQLite 数据库备份/恢复/校验/列表工具（Task 34）")
    p.add_argument(
        "--action",
        required=True,
        choices=["backup", "restore", "verify", "list"],
        help="操作类型：backup / restore / verify / list",
    )
    p.add_argument("--db", default=None, help="数据库路径（backup/restore/verify 需要）")
    p.add_argument("--output", default="backups", help="备份输出目录（backup）或备份列表目录（list）；默认 backups/")
    p.add_argument("--backup", default=None, help="恢复时使用的备份 .db 文件路径（restore 需要）")
    return p.parse_args(argv)


def main(argv=None):
    args = _parse_args(argv if argv is not None else sys.argv[1:])
    mgr = BackupManager()

    if args.action == "backup":
        if not args.db:
            print("[error] backup 操作需要 --db", file=sys.stderr)
            return 2
        if not os.path.isfile(args.db):
            print(f"[error] 源数据库不存在: {args.db}", file=sys.stderr)
            return 3
        path = mgr.backup(args.db, args.output)
        print(f"[ok] 备份完成: {path}")
        print(f"[ok] JSON 副本: {os.path.splitext(path)[0] + '.json'}")
        ok, msg = mgr.verify(path)
        print(f"[verify] {'PASS' if ok else 'FAIL'} -> {msg}")
        return 0 if ok else 4

    if args.action == "restore":
        if not args.backup:
            print("[error] restore 操作需要 --backup", file=sys.stderr)
            return 2
        if not args.db:
            print("[error] restore 操作需要 --db", file=sys.stderr)
            return 2
        if not os.path.isfile(args.backup):
            print(f"[error] 备份文件不存在: {args.backup}", file=sys.stderr)
            return 3
        path = mgr.restore(args.backup, args.db)
        ok, msg = mgr.verify(path)
        print(f"[ok] 恢复完成: {path}")
        print(f"[verify] {'PASS' if ok else 'FAIL'} -> {msg}")
        return 0 if ok else 4

    if args.action == "verify":
        if not args.db:
            print("[error] verify 操作需要 --db", file=sys.stderr)
            return 2
        if not os.path.isfile(args.db):
            print(f"[error] 数据库不存在: {args.db}", file=sys.stderr)
            return 3
        ok, msg = mgr.verify(args.db)
        print(f"[{'PASS' if ok else 'FAIL'}] {args.db} -> {msg}")
        return 0 if ok else 4

    if args.action == "list":
        items = mgr.list_backups(args.output)
        if not items:
            print(f"[info] {args.output} 下无备份文件")
            return 0
        print(f"[info] {args.output} 下共 {len(items)} 个备份（最新在前）：")
        for p in items:
            print(f"  {p}")
        return 0

    return 2


if __name__ == "__main__":
    sys.exit(main())
