"""R2-EDM-06 修复回归：受控采集会话 consent_id 强制必填（fail-closed）。

覆盖：
- consent_id 缺失 / None / 空白字符串 → ValueError 拒绝；
- 非 consent_record 库（governance 未部署）下有效非空 consent_id → 放行；
- 存在 consent_record 表时：active 授权放行；revoked / 不存在 → 拒绝。
"""

import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
EDGE = REPO_ROOT / "src" / "edge_platform"
SRC = REPO_ROOT / "src"
for p in (str(EDGE), str(SRC)):
    if p not in sys.path:
        sys.path.insert(0, p)

from collection.session import SessionManager  # noqa: E402


class _FakeStorage:
    """与 SessionManager 交互的最小 Storage 替身（仅 db_path）。"""

    def __init__(self, db_path):
        self.db_path = db_path


_CONSENT_DDL = """
CREATE TABLE IF NOT EXISTS consent_record (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT UNIQUE NOT NULL,
  person_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  granted_by TEXT,
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT,
  audit_ref TEXT
);
"""


class ConsentRequiredTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.db_path = os.path.join(self.tmp, "collect.db")
        self.sm = SessionManager(_FakeStorage(self.db_path))

    def _seed_consent_table(self, records):
        with sqlite3.connect(self.db_path) as c:
            c.executescript(_CONSENT_DDL)
            for rid, status in records:
                c.execute(
                    "INSERT INTO consent_record(record_id,person_id,purpose,status,granted_at)"
                    " VALUES (?,?,?,?,?)",
                    (rid, "P-1", "TELEMETRY", status, "2026-08-18T00:00:00Z"),
                )

    def test_missing_consent_rejected_fail_closed(self):
        # R2-EDM-06：缺失 consent_id 不得再开启采集会话
        with self.assertRaises(ValueError):
            self.sm.start_session(person_id="P-1", device_id="D-1")

    def test_blank_consent_rejected_fail_closed(self):
        for bad in ("", "   ", None):
            with self.assertRaises(ValueError):
                self.sm.start_session(person_id="P-1", device_id="D-1", consent_id=bad)

    def test_valid_consent_allowed_without_governance_table(self):
        # governance 表未部署的库：非空校验兜底，合法 consent_id 放行
        sid = self.sm.start_session(person_id="P-1", device_id="D-1", consent_id="AUTH-001")
        self.assertTrue(sid.startswith("SES"))
        self.assertEqual(self.sm.get_session(sid)["consent_id"], "AUTH-001")

    def test_active_consent_allowed_with_governance_table(self):
        self._seed_consent_table([("AUTH-OK", "active")])
        sid = self.sm.start_session(person_id="P-1", device_id="D-1", consent_id="AUTH-OK")
        self.assertEqual(self.sm.get_session(sid)["consent_id"], "AUTH-OK")

    def test_revoked_or_unknown_consent_rejected(self):
        self._seed_consent_table([("AUTH-GONE", "revoked")])
        with self.assertRaises(ValueError):
            self.sm.start_session(person_id="P-1", device_id="D-1", consent_id="AUTH-GONE")
        with self.assertRaises(ValueError):
            self.sm.start_session(person_id="P-1", device_id="D-1", consent_id="AUTH-NOT-EXIST")


if __name__ == "__main__":
    unittest.main()
