"""Task 14.2 / 14.3 治理与审计表 CRUD 单元测试。

覆盖 stubs.Storage 新增的 7 张表（device_protocol_version / event_handling /
assignment / model_registry / rule_registry / consent_record / audit_log）的
insert/list/upsert 与过滤、分页、幂等迁移，并验证不破坏旧表。

纯 Python 标准库 unittest；运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_storage_tables -v
"""

import os
import shutil
import sqlite3
import sys
import tempfile
import unittest

# 支持 PYTHONPATH=src 与直接运行两种方式
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform import stubs
from edge_platform.migrations import list_migrations, upgrade_all
from edge_platform.migrations.v001_add_governance_tables import upgrade as v001_upgrade


class _BaseStorageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_storage_")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.db_path = os.path.join(self.tmp, "test.db")
        self.storage = stubs.Storage(self.db_path)

    def tearDown(self):
        self.storage.close()


class AuditLogTest(_BaseStorageTest):
    def test_insert_and_list(self):
        rec = self.storage.insert_audit_log(
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
        self.assertEqual(rec["action"], "create")
        self.assertEqual(rec["actor_id"], "U-1")
        self.assertEqual(rec["target_type"], "risk_event")
        self.assertEqual(rec["target_id"], "EVT-1")
        self.assertIsNone(rec["before"])
        self.assertEqual(rec["after"], {"status": "open"})
        self.assertEqual(rec["result"], "success")
        self.assertEqual(rec["request_id"], "REQ-1")
        self.assertEqual(rec["source_ip"], "10.0.0.1")
        self.assertIn("ts", rec)
        # before/after 均为 dict 时也可往返
        rec2 = self.storage.insert_audit_log(
            "update", "U-2", "device", "EXO-001", before={"online": 0}, after={"online": 1}
        )
        self.assertEqual(rec2["before"], {"online": 0})
        self.assertEqual(rec2["after"], {"online": 1})
        # list 全量
        rows = self.storage.list_audit_logs()
        self.assertEqual(len(rows), 2)
        # 默认按 ts DESC, id DESC；第一条应是后插入的
        self.assertEqual(rows[0]["action"], "update")

    def test_filter_by_action_actor_target(self):
        self.storage.insert_audit_log("create", "U-1", "device", "EXO-001")
        self.storage.insert_audit_log("create", "U-2", "device", "EXO-002")
        self.storage.insert_audit_log("delete", "U-1", "device", "EXO-001")
        self.assertEqual(len(self.storage.list_audit_logs(action="create")), 2)
        self.assertEqual(len(self.storage.list_audit_logs(actor_id="U-1")), 2)
        self.assertEqual(len(self.storage.list_audit_logs(target_type="device")), 3)
        # 组合过滤
        self.assertEqual(len(self.storage.list_audit_logs(action="create", actor_id="U-1")), 1)
        # 不匹配返回空
        self.assertEqual(len(self.storage.list_audit_logs(target_type="person")), 0)

    def test_pagination(self):
        for i in range(5):
            self.storage.insert_audit_log("create", f"U-{i}", "device", f"EXO-{i}")
        page1 = self.storage.list_audit_logs(limit=2, offset=0)
        page2 = self.storage.list_audit_logs(limit=2, offset=2)
        page3 = self.storage.list_audit_logs(limit=2, offset=4)
        self.assertEqual(len(page1), 2)
        self.assertEqual(len(page2), 2)
        self.assertEqual(len(page3), 1)
        # 不同页不重叠（按 ts/id DESC 顺序）
        ids = {r["audit_id"] for r in page1 + page2 + page3}
        self.assertEqual(len(ids), 5)


class DeviceProtocolVersionTest(_BaseStorageTest):
    def test_insert_and_list(self):
        r1 = self.storage.insert_device_protocol_version("EXO-001", "v1.2", "fw-1.2.0", "hw-A")
        r2 = self.storage.insert_device_protocol_version("EXO-001", "v1.3", "fw-1.3.0", "hw-A", audit_ref="AUD-X")
        self.storage.insert_device_protocol_version("EXO-002", "v1.2", "fw-1.2.0", "hw-B")
        self.assertEqual(r1["device_id"], "EXO-001")
        self.assertEqual(r1["protocol_version"], "v1.2")
        self.assertEqual(r1["firmware_version"], "fw-1.2.0")
        self.assertEqual(r1["hardware_version"], "hw-A")
        self.assertIsNone(r1["audit_ref"])
        self.assertEqual(r2["audit_ref"], "AUD-X")
        self.assertIn("upgraded_at", r1)
        # 全量
        all_rows = self.storage.list_device_protocol_versions()
        self.assertEqual(len(all_rows), 3)
        # 按 device_id 过滤
        exo1 = self.storage.list_device_protocol_versions("EXO-001")
        self.assertEqual(len(exo1), 2)
        # 按 upgraded_at DESC，最新版本在前
        self.assertEqual(exo1[0]["protocol_version"], "v1.3")
        self.assertEqual(exo1[1]["protocol_version"], "v1.2")
        # 不存在的设备返回空
        self.assertEqual(self.storage.list_device_protocol_versions("EXO-999"), [])


class EventHandlingTest(_BaseStorageTest):
    def test_insert_and_list(self):
        r1 = self.storage.insert_event_handling("EVT-1", "班组长A", "confirm", comment="已现场核实")
        r2 = self.storage.insert_event_handling("EVT-1", "班组长A", "close", audit_ref="AUD-Y")
        self.storage.insert_event_handling("EVT-2", "班组长B", "escalate")
        self.assertEqual(r1["event_id"], "EVT-1")
        self.assertEqual(r1["handler_id"], "班组长A")
        self.assertEqual(r1["action"], "confirm")
        self.assertEqual(r1["comment"], "已现场核实")
        self.assertIsNone(r1["audit_ref"])
        self.assertEqual(r2["audit_ref"], "AUD-Y")
        # 全量
        self.assertEqual(len(self.storage.list_event_handlings()), 3)
        # 按 event_id 过滤
        evt1 = self.storage.list_event_handlings("EVT-1")
        self.assertEqual(len(evt1), 2)
        # 按 handled_at DESC
        self.assertEqual(evt1[0]["action"], "close")
        self.assertEqual(evt1[1]["action"], "confirm")
        self.assertEqual(self.storage.list_event_handlings("EVT-9"), [])


class AssignmentTest(_BaseStorageTest):
    def test_upsert_insert_then_update_id_stable(self):
        rec = self.storage.upsert_assignment(
            "ASG-001", "P-001", device_id="EXO-001", task_id="T-1", status="proposed", recommended_by="scheduler-1"
        )
        self.assertEqual(rec["assignment_id"], "ASG-001")
        self.assertEqual(rec["person_id"], "P-001")
        self.assertEqual(rec["device_id"], "EXO-001")
        self.assertEqual(rec["task_id"], "T-1")
        self.assertEqual(rec["status"], "proposed")
        self.assertEqual(rec["recommended_by"], "scheduler-1")
        self.assertIsNone(rec["confirmed_by"])
        self.assertIsNone(rec["confirmed_at"])
        original_id = rec["id"]
        # 再次 upsert 同 assignment_id：应更新而非新增，id 保持稳定
        rec2 = self.storage.upsert_assignment(
            "ASG-001",
            "P-001",
            device_id="EXO-001",
            task_id="T-1",
            status="confirmed",
            recommended_by="scheduler-1",
            confirmed_by="班组长A",
            confirmed_at="2026-07-31T10:00:00+08:00",
            audit_ref="AUD-C",
        )
        self.assertEqual(rec2["id"], original_id)
        self.assertEqual(rec2["status"], "confirmed")
        self.assertEqual(rec2["confirmed_by"], "班组长A")
        self.assertEqual(rec2["audit_ref"], "AUD-C")
        # 仅一条记录
        self.assertEqual(len(self.storage.list_assignments()), 1)

    def test_list_filters(self):
        self.storage.upsert_assignment("ASG-1", "P-001", status="proposed")
        self.storage.upsert_assignment("ASG-2", "P-002", status="confirmed")
        self.storage.upsert_assignment("ASG-3", "P-001", status="proposed")
        self.assertEqual(len(self.storage.list_assignments()), 3)
        self.assertEqual(len(self.storage.list_assignments(person_id="P-001")), 2)
        self.assertEqual(len(self.storage.list_assignments(status="confirmed")), 1)
        self.assertEqual(len(self.storage.list_assignments(person_id="P-001", status="confirmed")), 0)
        # 组合命中
        self.assertEqual(len(self.storage.list_assignments(person_id="P-002", status="confirmed")), 1)


class ModelRegistryTableTest(_BaseStorageTest):
    def test_insert_and_list(self):
        r1 = self.storage.insert_model_record("MODEL-A", "action_classifier", "0.1", model_card_uri="card://a")
        self.storage.insert_model_record("MODEL-B", "action_classifier", "0.2", status="active")
        self.storage.insert_model_record("MODEL-C", "fatigue_scorer", "0.1", status="retired")
        self.assertEqual(r1["model_id"], "MODEL-A")
        self.assertEqual(r1["model_type"], "action_classifier")
        self.assertEqual(r1["version"], "0.1")
        self.assertEqual(r1["status"], "candidate")  # 默认
        self.assertEqual(r1["model_card_uri"], "card://a")
        self.assertIn("registered_at", r1)
        # 全量
        self.assertEqual(len(self.storage.list_models()), 3)
        # 按 model_type
        self.assertEqual(len(self.storage.list_models(model_type="action_classifier")), 2)
        # 按 status
        self.assertEqual(len(self.storage.list_models(status="active")), 1)
        self.assertEqual(len(self.storage.list_models(status="retired")), 1)
        # 组合
        self.assertEqual(len(self.storage.list_models(model_type="fatigue_scorer", status="retired")), 1)
        self.assertEqual(len(self.storage.list_models(model_type="action_classifier", status="retired")), 0)

    def test_unique_model_id(self):
        self.storage.insert_model_record("MODEL-X", "scheduler", "0.1")
        with self.assertRaises(sqlite3.IntegrityError):
            self.storage.insert_model_record("MODEL-X", "scheduler", "0.2")


class RuleRegistryTableTest(_BaseStorageTest):
    def test_insert_and_list(self):
        r1 = self.storage.insert_rule_record(
            "RULE-LOAD", "v0.1", enabled=True, config_json={"threshold": 0.7}, severity="L2", approver_id="admin1"
        )
        r2 = self.storage.insert_rule_record("RULE-POSTURE", "v0.1", enabled=False, severity="L1")
        self.storage.insert_rule_record("RULE-LOAD", "v0.2", enabled=True, config_json={"threshold": 0.8})
        self.assertEqual(r1["rule_id"], "RULE-LOAD")
        self.assertEqual(r1["rule_version"], "v0.1")
        self.assertEqual(r1["enabled"], 1)
        self.assertEqual(r1["config"], {"threshold": 0.7})
        self.assertEqual(r1["severity"], "L2")
        self.assertEqual(r1["approver_id"], "admin1")
        self.assertEqual(r2["enabled"], 0)
        self.assertIsNone(r2["config"])
        # 全量
        self.assertEqual(len(self.storage.list_rules()), 3)
        # 按 enabled 过滤
        enabled = self.storage.list_rules(enabled=True)
        self.assertEqual(len(enabled), 2)
        for r in enabled:
            self.assertEqual(r["enabled"], 1)
        disabled = self.storage.list_rules(enabled=False)
        self.assertEqual(len(disabled), 1)
        self.assertEqual(disabled[0]["enabled"], 0)
        # config 往返
        load_v2 = [r for r in enabled if r["rule_version"] == "v0.2"][0]
        self.assertEqual(load_v2["config"], {"threshold": 0.8})

    def test_unique_rule_id_version(self):
        self.storage.insert_rule_record("RULE-DUP", "v0.1")
        with self.assertRaises(sqlite3.IntegrityError):
            self.storage.insert_rule_record("RULE-DUP", "v0.1")
        # 同 rule_id 不同 version 允许
        self.storage.insert_rule_record("RULE-DUP", "v0.2")
        self.assertEqual(len(self.storage.list_rules()), 2)


class ConsentRecordTableTest(_BaseStorageTest):
    def test_insert_and_list(self):
        r1 = self.storage.insert_consent_record("CONSENT-1", "P-001", "TELEMETRY", "leader1")
        self.storage.insert_consent_record("CONSENT-2", "P-001", "VIDEO", "leader1", status="active")
        r3 = self.storage.insert_consent_record(
            "CONSENT-3",
            "P-002",
            "TELEMETRY",
            "leader2",
            status="revoked",
            revoked_at="2026-07-31T12:00:00+08:00",
            revoke_reason="员工离职",
            audit_ref="AUD-R",
        )
        self.assertEqual(r1["record_id"], "CONSENT-1")
        self.assertEqual(r1["person_id"], "P-001")
        self.assertEqual(r1["purpose"], "TELEMETRY")
        self.assertEqual(r1["status"], "active")  # 默认
        self.assertEqual(r1["granted_by"], "leader1")
        self.assertIsNone(r1["revoked_at"])
        self.assertIsNone(r1["revoke_reason"])
        self.assertIn("granted_at", r1)
        self.assertEqual(r3["status"], "revoked")
        self.assertEqual(r3["revoke_reason"], "员工离职")
        self.assertEqual(r3["audit_ref"], "AUD-R")
        # 全量
        self.assertEqual(len(self.storage.list_consent_records()), 3)
        # 按 person_id
        self.assertEqual(len(self.storage.list_consent_records(person_id="P-001")), 2)
        # 按 status
        self.assertEqual(len(self.storage.list_consent_records(status="active")), 2)
        self.assertEqual(len(self.storage.list_consent_records(status="revoked")), 1)
        # 组合
        self.assertEqual(len(self.storage.list_consent_records(person_id="P-002", status="revoked")), 1)
        self.assertEqual(len(self.storage.list_consent_records(person_id="P-001", status="revoked")), 0)

    def test_unique_record_id(self):
        self.storage.insert_consent_record("CONSENT-X", "P-1", "VIDEO", "l1")
        with self.assertRaises(sqlite3.IntegrityError):
            self.storage.insert_consent_record("CONSENT-X", "P-2", "VIDEO", "l2")


class MigrationTest(unittest.TestCase):
    """Task 14.2：迁移脚本幂等性、不破坏旧表。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_mig_")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.db_path = os.path.join(self.tmp, "mig.db")

    def _table_names(self, db_path):
        conn = sqlite3.connect(db_path)
        try:
            rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
            return {r[0] for r in rows}
        finally:
            conn.close()

    def test_v001_upgrade_creates_all_tables(self):
        v001_upgrade(self.db_path)
        tables = self._table_names(self.db_path)
        for t in (
            "device_protocol_version",
            "event_handling",
            "assignment",
            "model_registry",
            "rule_registry",
            "consent_record",
            "audit_log",
        ):
            self.assertIn(t, tables, f"缺失表: {t}")

    def test_v001_upgrade_is_idempotent(self):
        v001_upgrade(self.db_path)
        # 再跑一次不应抛错，表数不变
        v001_upgrade(self.db_path)
        tables = self._table_names(self.db_path)
        for t in (
            "device_protocol_version",
            "event_handling",
            "assignment",
            "model_registry",
            "rule_registry",
            "consent_record",
            "audit_log",
        ):
            self.assertIn(t, tables)

    def test_v001_upgrade_on_connection_object(self):
        conn = sqlite3.connect(self.db_path)
        try:
            n = v001_upgrade(conn)
            self.assertEqual(n, 7)  # 7 张新表
        finally:
            conn.close()

    def test_upgrade_all_records_and_skips_applied(self):
        newly = upgrade_all(self.db_path)
        self.assertEqual(newly, ["001"])
        # 再次执行：已应用的不再重复标记
        newly2 = upgrade_all(self.db_path)
        self.assertEqual(newly2, [])
        # 迁移记录表已记录
        conn = sqlite3.connect(self.db_path)
        try:
            rows = conn.execute("SELECT version FROM schema_migrations").fetchall()
        finally:
            conn.close()
        self.assertEqual([r[0] for r in rows], ["001"])

    def test_list_migrations_registered(self):
        migrations = list_migrations()
        self.assertTrue(any(v == "001" for v, _ in migrations))

    def test_migration_does_not_break_old_tables(self):
        # 先建一个只有旧 5 表的 DB（模拟旧 schema）
        old_schema = """
        CREATE TABLE person (person_id TEXT PRIMARY KEY, display_name TEXT NOT NULL);
        CREATE TABLE device (device_id TEXT PRIMARY KEY, device_type TEXT NOT NULL);
        CREATE TABLE telemetry (record_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, ts TEXT NOT NULL);
        CREATE TABLE inference (inference_id TEXT PRIMARY KEY, device_id TEXT NOT NULL);
        CREATE TABLE risk_event (event_id TEXT PRIMARY KEY, event_code TEXT NOT NULL);
        INSERT INTO person VALUES ('P-OLD', '旧人员');
        """
        conn = sqlite3.connect(self.db_path)
        conn.executescript(old_schema)
        conn.commit()
        conn.close()
        # 执行迁移
        v001_upgrade(self.db_path)
        # 旧表与旧数据仍在
        tables = self._table_names(self.db_path)
        for t in ("person", "device", "telemetry", "inference", "risk_event"):
            self.assertIn(t, tables)
        for t in (
            "device_protocol_version",
            "event_handling",
            "assignment",
            "model_registry",
            "rule_registry",
            "consent_record",
            "audit_log",
        ):
            self.assertIn(t, tables)
        conn = sqlite3.connect(self.db_path)
        try:
            row = conn.execute("SELECT display_name FROM person WHERE person_id='P-OLD'").fetchone()
        finally:
            conn.close()
        self.assertEqual(row[0], "旧人员")

    def test_storage_works_after_migration_only(self):
        # 仅执行迁移脚本（不走 stubs.SCHEMA）后，Storage 应能复用并操作新表
        v001_upgrade(self.db_path)
        storage = stubs.Storage(self.db_path)
        try:
            storage.insert_audit_log("boot", "system", "platform", "ewoh")
            self.assertEqual(len(storage.list_audit_logs()), 1)
            # 旧表 CRUD 仍可用（init_db 幂等）
            storage.upsert_person(person_id="P-1", display_name="X")
            self.assertEqual(len(storage.list_people()), 1)
        finally:
            storage.close()


class OldTablesUnaffectedTest(_BaseStorageTest):
    """新表加入后旧表 CRUD 与 counts() 不受影响。"""

    def test_old_tables_crud_and_counts(self):
        self.storage.upsert_person(person_id="P-1", display_name="A")
        self.storage.upsert_device(device_id="EXO-1", model="M", source_type="simulated")
        self.storage.insert_telemetry(
            {
                "record_id": "TS-1",
                "device_id": "EXO-1",
                "timestamp": "2026-07-31T00:00:00+08:00",
                "sequence": 1,
                "source_type": "simulated",
                "telemetry": {"x": 1},
                "quality": {"status": "good"},
            }
        )
        self.storage.insert_inference(
            {
                "inference_id": "INF-1",
                "device_id": "EXO-1",
                "ts_start": "2026-07-31T00:00:00+08:00",
                "ts_end": "2026-07-31T00:00:00+08:00",
                "label": "stand",
                "source_type": "simulated",
            }
        )
        self.storage.insert_event(
            {
                "event_id": "EVT-1",
                "event_code": "X",
                "severity": "L1",
                "status": "open",
                "start_time": "2026-07-31T00:00:00+08:00",
                "trigger": {},
                "evidence": {},
                "source_type": "simulated",
            }
        )
        c = self.storage.counts()
        self.assertEqual(c["person"], 1)
        self.assertEqual(c["device"], 1)
        self.assertEqual(c["telemetry"], 1)
        self.assertEqual(c["inference"], 1)
        self.assertEqual(c["risk_event"], 1)

    def test_reset_demo_does_not_touch_governance_tables(self):
        # reset_demo 只清 telemetry/inference/risk_event 的非 real 数据，不影响新表
        self.storage.insert_audit_log("x", "u", "t", "1")
        self.storage.insert_event_handling("EVT-1", "h", "confirm")
        self.storage.reset_demo()
        self.assertEqual(len(self.storage.list_audit_logs()), 1)
        self.assertEqual(len(self.storage.list_event_handlings()), 1)


if __name__ == "__main__":
    unittest.main()
