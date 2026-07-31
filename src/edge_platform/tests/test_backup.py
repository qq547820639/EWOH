"""Task 34 备份恢复测试：BackupManager + CLI。

覆盖：
- backup：生成 .db + .json 副本、JSON 含关键表行、带时间戳；
- restore：从备份恢复、覆盖已有目标、verify 通过；
- verify：正常库 ok、损坏库 fail、不存在抛 FileNotFoundError；
- list_backups：按时间戳倒序、空目录返回 []；
- CLI：backup/restore/verify/list 四种 action 退出码正确。

纯 Python 标准库 unittest + sqlite3 + tempfile；运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_backup -v
"""

import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.backup import BackupManager  # noqa: E402
from edge_platform.scripts import backup_db  # noqa: E402


def _make_test_db(path):
    """创建一个包含 person/device/telemetry 三张表的测试库。"""
    conn = sqlite3.connect(path)
    try:
        conn.executescript(
            """
            CREATE TABLE person (person_id TEXT PRIMARY KEY, name TEXT);
            CREATE TABLE device (device_id TEXT PRIMARY KEY, model TEXT);
            CREATE TABLE telemetry (id INTEGER PRIMARY KEY, device_id TEXT, val REAL);
            """)
        conn.execute("INSERT INTO person VALUES ('P1', 'Alice')")
        conn.execute("INSERT INTO person VALUES ('P2', 'Bob')")
        conn.execute("INSERT INTO device VALUES ('D1', 'EXO-A1')")
        conn.execute("INSERT INTO telemetry VALUES (1, 'D1', 3.14)")
        conn.commit()
    finally:
        conn.close()


class BackupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_bk_")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.db_path = os.path.join(self.tmp, "demo.db")
        _make_test_db(self.db_path)
        self.output_dir = os.path.join(self.tmp, "backups")
        self.mgr = BackupManager()

    def test_backup_creates_db_and_json(self):
        db_backup = self.mgr.backup(self.db_path, self.output_dir)
        self.assertTrue(os.path.isfile(db_backup))
        self.assertTrue(db_backup.endswith(".db"))
        json_path = os.path.splitext(db_backup)[0] + ".json"
        self.assertTrue(os.path.isfile(json_path))
        # 备份文件名带时间戳前缀
        self.assertIn("ewoh_backup_", os.path.basename(db_backup))

    def test_backup_json_contains_tables(self):
        self.mgr.backup(self.db_path, self.output_dir)
        # 找到 JSON 副本
        files = [f for f in os.listdir(self.output_dir) if f.endswith(".json")]
        self.assertEqual(len(files), 1)
        with open(os.path.join(self.output_dir, files[0]), encoding="utf-8") as f:
            manifest = json.load(f)
        self.assertEqual(manifest["backup_type"], "ewoh_sqlite_backup")
        tables = manifest["tables"]
        # 三张表均已导出
        self.assertIn("person", tables)
        self.assertIn("device", tables)
        self.assertIn("telemetry", tables)
        # person 表两行
        self.assertEqual(len(tables["person"]), 2)
        self.assertEqual(tables["person"][0]["person_id"], "P1")
        # telemetry 含数值
        self.assertEqual(len(tables["telemetry"]), 1)
        self.assertAlmostEqual(tables["telemetry"][0]["val"], 3.14)

    def test_backup_db_is_valid_sqlite(self):
        db_backup = self.mgr.backup(self.db_path, self.output_dir)
        # 备份库可打开且数据完整
        conn = sqlite3.connect(db_backup)
        try:
            rows = conn.execute("SELECT count(*) FROM person").fetchone()
            self.assertEqual(rows[0], 2)
        finally:
            conn.close()

    def test_backup_source_not_found(self):
        with self.assertRaises(FileNotFoundError):
            self.mgr.backup(os.path.join(self.tmp, "nope.db"), self.output_dir)


class RestoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_rs_")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.db_path = os.path.join(self.tmp, "demo.db")
        _make_test_db(self.db_path)
        self.output_dir = os.path.join(self.tmp, "backups")
        self.mgr = BackupManager()
        self.backup_path = self.mgr.backup(self.db_path, self.output_dir)

    def test_restore_to_new_path(self):
        target = os.path.join(self.tmp, "restored.db")
        path = self.mgr.restore(self.backup_path, target)
        self.assertTrue(os.path.isfile(path))
        # 数据完整
        conn = sqlite3.connect(target)
        try:
            rows = conn.execute("SELECT count(*) FROM person").fetchone()
            self.assertEqual(rows[0], 2)
        finally:
            conn.close()

    def test_restore_overwrites_existing(self):
        target = os.path.join(self.tmp, "restored.db")
        # 先写一个空库（无表）
        conn = sqlite3.connect(target)
        conn.execute("CREATE TABLE x (a INTEGER)")
        conn.commit()
        conn.close()
        # 恢复覆盖
        self.mgr.restore(self.backup_path, target)
        conn = sqlite3.connect(target)
        try:
            # 应有 person 表（来自备份），不应有 x 表
            tabs = {r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
            self.assertIn("person", tabs)
            self.assertNotIn("x", tabs)
        finally:
            conn.close()

    def test_restore_backup_not_found(self):
        with self.assertRaises(FileNotFoundError):
            self.mgr.restore(os.path.join(self.tmp, "nope.db"),
                             os.path.join(self.tmp, "out.db"))

    def test_backup_restore_roundtrip_verify(self):
        target = os.path.join(self.tmp, "roundtrip.db")
        self.mgr.restore(self.backup_path, target)
        ok, msg = BackupManager.verify(target)
        self.assertTrue(ok)
        self.assertEqual(msg, "ok")


class VerifyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_vf_")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_verify_valid_db(self):
        db = os.path.join(self.tmp, "good.db")
        conn = sqlite3.connect(db)
        conn.execute("CREATE TABLE t (a INTEGER)")
        conn.commit()
        conn.close()
        ok, msg = BackupManager.verify(db)
        self.assertTrue(ok)
        self.assertEqual(msg, "ok")

    def test_verify_corrupted_db(self):
        db = os.path.join(self.tmp, "bad.db")
        # 写入非 SQLite 字节
        with open(db, "wb") as f:
            f.write(b"not a sqlite database content")
        ok, msg = BackupManager.verify(db)
        self.assertFalse(ok)
        # 损坏时 message 非 "ok"
        self.assertNotEqual(msg, "ok")

    def test_verify_not_found(self):
        with self.assertRaises(FileNotFoundError):
            BackupManager.verify(os.path.join(self.tmp, "nope.db"))


class ListBackupsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_lb_")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.db_path = os.path.join(self.tmp, "demo.db")
        _make_test_db(self.db_path)
        self.output_dir = os.path.join(self.tmp, "backups")
        self.mgr = BackupManager()

    def test_empty_dir_returns_empty(self):
        os.makedirs(self.output_dir, exist_ok=True)
        self.assertEqual(self.mgr.list_backups(self.output_dir), [])

    def test_nonexistent_dir_returns_empty(self):
        self.assertEqual(self.mgr.list_backups(os.path.join(self.tmp, "nope")), [])

    def test_lists_backups_newest_first(self):
        # 创建两个备份（间隔足以区分时间戳）
        p1 = self.mgr.backup(self.db_path, self.output_dir)
        # 间隔 1 秒以确保文件名时间戳不同
        time.sleep(1.0)
        p2 = self.mgr.backup(self.db_path, self.output_dir)
        items = self.mgr.list_backups(self.output_dir)
        self.assertEqual(len(items), 2)
        # 最新在前（倒序）
        self.assertEqual(items[0], p2)
        self.assertEqual(items[1], p1)

    def test_only_lists_backup_files(self):
        # 放入非备份 .db 文件，不应被列出
        self.mgr.backup(self.db_path, self.output_dir)
        open(os.path.join(self.output_dir, "random.db"), "w").close()
        items = self.mgr.list_backups(self.output_dir)
        self.assertEqual(len(items), 1)
        self.assertTrue(os.path.basename(items[0]).startswith("ewoh_backup_"))


class CLITest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_cli_")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.db_path = os.path.join(self.tmp, "demo.db")
        _make_test_db(self.db_path)
        self.output_dir = os.path.join(self.tmp, "backups")

    def test_cli_backup(self):
        rc = backup_db.main(["--action", "backup", "--db", self.db_path,
                             "--output", self.output_dir])
        self.assertEqual(rc, 0)
        items = BackupManager.list_backups(self.output_dir)
        self.assertEqual(len(items), 1)

    def test_cli_verify(self):
        rc = backup_db.main(["--action", "verify", "--db", self.db_path])
        self.assertEqual(rc, 0)

    def test_cli_list_empty(self):
        rc = backup_db.main(["--action", "list", "--output", self.output_dir])
        self.assertEqual(rc, 0)

    def test_cli_list_with_backups(self):
        backup_db.main(["--action", "backup", "--db", self.db_path,
                        "--output", self.output_dir])
        rc = backup_db.main(["--action", "list", "--output", self.output_dir])
        self.assertEqual(rc, 0)

    def test_cli_restore(self):
        # 先备份
        backup_db.main(["--action", "backup", "--db", self.db_path,
                        "--output", self.output_dir])
        backup_file = BackupManager.list_backups(self.output_dir)[0]
        # 恢复到新路径
        target = os.path.join(self.tmp, "restored.db")
        rc = backup_db.main(["--action", "restore", "--backup", backup_file,
                             "--db", target])
        self.assertEqual(rc, 0)
        self.assertTrue(os.path.isfile(target))
        # 验证恢复后的数据
        conn = sqlite3.connect(target)
        try:
            rows = conn.execute("SELECT count(*) FROM person").fetchone()
            self.assertEqual(rows[0], 2)
        finally:
            conn.close()

    def test_cli_backup_missing_db(self):
        rc = backup_db.main(["--action", "backup",
                             "--db", os.path.join(self.tmp, "nope.db"),
                             "--output", self.output_dir])
        self.assertEqual(rc, 3)

    def test_cli_backup_missing_db_arg(self):
        rc = backup_db.main(["--action", "backup", "--output", self.output_dir])
        self.assertEqual(rc, 2)


if __name__ == "__main__":
    unittest.main()
