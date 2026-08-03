"""Task 29 统一审计日志单元测试。

覆盖：
- AuditLogger.log：写入审计日志，返回记录含 audit_id/ts、before/after dict 往返。
- AuditLogger.query：按 action/actor_id/target_type 过滤、分页、默认排序。
- 包装 Storage 不破坏既有行为。

纯 Python 标准库 unittest；运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_audit -v
"""

import os
import shutil
import sys
import tempfile
import unittest

# 支持 PYTHONPATH=src 与直接运行两种方式
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.audit import AuditLogger
from edge_platform.stubs import Storage


class _BaseAuditTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_audit_")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.db_path = os.path.join(self.tmp, "test.db")
        self.storage = Storage(self.db_path)
        self.logger = AuditLogger(self.storage)

    def tearDown(self):
        self.storage.close()


class AuditLoggerWriteTest(_BaseAuditTest):
    def test_log_returns_record_with_audit_id_and_ts(self):
        rec = self.logger.log(
            "create",
            "U-1",
            "risk_event",
            "EVT-1",
            before=None,
            after={"status": "open"},
            result="success",
            request_id="REQ-1",
            source_ip="10.0.0.1",
        )
        self.assertTrue(rec["audit_id"].startswith("AUD-"))
        self.assertIn("ts", rec)
        self.assertEqual(rec["action"], "create")
        self.assertEqual(rec["actor_id"], "U-1")
        self.assertEqual(rec["target_type"], "risk_event")
        self.assertEqual(rec["target_id"], "EVT-1")
        self.assertIsNone(rec["before"])
        self.assertEqual(rec["after"], {"status": "open"})
        self.assertEqual(rec["result"], "success")
        self.assertEqual(rec["request_id"], "REQ-1")
        self.assertEqual(rec["source_ip"], "10.0.0.1")

    def test_log_before_after_dict_roundtrip(self):
        rec = self.logger.log("update", "U-2", "device", "EXO-001", before={"online": 0}, after={"online": 1})
        self.assertEqual(rec["before"], {"online": 0})
        self.assertEqual(rec["after"], {"online": 1})

    def test_log_minimal_fields(self):
        rec = self.logger.log("boot", "system")
        self.assertTrue(rec["audit_id"].startswith("AUD-"))
        self.assertEqual(rec["action"], "boot")
        self.assertEqual(rec["actor_id"], "system")
        self.assertIsNone(rec["target_type"])
        self.assertIsNone(rec["target_id"])
        self.assertEqual(rec["result"], "success")

    def test_log_failure_result(self):
        rec = self.logger.log("export", "U-3", result="failure")
        self.assertEqual(rec["result"], "failure")

    def test_each_log_generates_unique_audit_id(self):
        ids = {self.logger.log("create", "U-1")["audit_id"] for _ in range(5)}
        self.assertEqual(len(ids), 5)


class AuditLoggerQueryTest(_BaseAuditTest):
    def test_query_all(self):
        self.logger.log("create", "U-1", "device", "EXO-001")
        self.logger.log("update", "U-2", "device", "EXO-002")
        rows = self.logger.query()
        self.assertEqual(len(rows), 2)
        # 默认按 ts DESC，最新插入在前
        self.assertEqual(rows[0]["action"], "update")

    def test_query_filter_by_action(self):
        self.logger.log("create", "U-1", "device", "EXO-1")
        self.logger.log("create", "U-2", "device", "EXO-2")
        self.logger.log("delete", "U-1", "device", "EXO-1")
        self.assertEqual(len(self.logger.query(action="create")), 2)
        self.assertEqual(len(self.logger.query(action="delete")), 1)

    def test_query_filter_by_actor(self):
        self.logger.log("create", "U-1", "device", "EXO-1")
        self.logger.log("create", "U-2", "device", "EXO-2")
        self.logger.log("delete", "U-1", "device", "EXO-1")
        self.assertEqual(len(self.logger.query(actor_id="U-1")), 2)
        self.assertEqual(len(self.logger.query(actor_id="U-2")), 1)

    def test_query_filter_by_target_type(self):
        self.logger.log("create", "U-1", "device", "EXO-1")
        self.logger.log("create", "U-2", "person", "P-1")
        self.assertEqual(len(self.logger.query(target_type="device")), 1)
        self.assertEqual(len(self.logger.query(target_type="person")), 1)
        self.assertEqual(len(self.logger.query(target_type="none")), 0)

    def test_query_combined_filter(self):
        self.logger.log("create", "U-1", "device", "EXO-1")
        self.logger.log("create", "U-2", "device", "EXO-2")
        self.logger.log("delete", "U-1", "device", "EXO-1")
        rows = self.logger.query(action="create", actor_id="U-1", target_type="device")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["target_id"], "EXO-1")

    def test_query_pagination(self):
        for i in range(5):
            self.logger.log("create", f"U-{i}", "device", f"EXO-{i}")
        page1 = self.logger.query(limit=2, offset=0)
        page2 = self.logger.query(limit=2, offset=2)
        page3 = self.logger.query(limit=2, offset=4)
        self.assertEqual(len(page1), 2)
        self.assertEqual(len(page2), 2)
        self.assertEqual(len(page3), 1)
        ids = {r["audit_id"] for r in page1 + page2 + page3}
        self.assertEqual(len(ids), 5)

    def test_query_empty(self):
        self.assertEqual(self.logger.query(), [])


if __name__ == "__main__":
    unittest.main()
