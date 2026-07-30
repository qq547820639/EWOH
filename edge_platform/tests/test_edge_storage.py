"""edge.storage 真实 SQLite 持久层单元测试。"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from edge.storage import Storage


def _msg(seq=1, device_id="EXO-S-001", status="good", source_type="real",
         firmware="1.4.2", raw_ref=None):
    return {
        "record_id": "rec-%s-%d" % (device_id, seq),
        "device_id": device_id,
        "timestamp": "2026-07-30T10:00:%02d.000+08:00" % (seq % 60),
        "sequence": seq,
        "ingested_at": "2026-07-30T10:00:%02d.001+08:00" % (seq % 60),
        "device_model": "NY-EXO-A1",
        "firmware_version": firmware,
        "protocol_version": "NXP1-1.0",
        "raw_ref": raw_ref,
        "telemetry": {"pitch_deg": 32.1, "torque_nm": 18.6, "battery_percent": 82,
                      "acceleration": [0.0, 0.0, 9.81]},
        "quality": {"status": status},
        "source_type": source_type,
    }


class StorageBasicTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.db = os.path.join(self.tmp, "test.db")
        self.storage = Storage(self.db)

    def tearDown(self):
        self.storage.close()

    def test_init_db_creates_tables(self):
        counts = self.storage.counts()
        for t in ("person", "device", "telemetry", "inference", "risk_event",
                  "raw_frame", "audit_log"):
            self.assertIn(t, counts)
            self.assertEqual(counts[t], 0)

    def test_telemetry_roundtrip_with_new_fields(self):
        msg = _msg(seq=1)
        self.storage.insert_telemetry(msg)
        latest = self.storage.latest_telemetry("EXO-S-001")
        self.assertEqual(latest["record_id"], msg["record_id"])
        self.assertEqual(latest["device_model"], "NY-EXO-A1")
        self.assertEqual(latest["firmware_version"], "1.4.2")
        self.assertEqual(latest["protocol_version"], "NXP1-1.0")
        self.assertIsNone(latest.get("raw_ref"))  # None 不透传
        self.assertEqual(latest["telemetry"]["pitch_deg"], 32.1)

    def test_query_telemetry_ordered(self):
        for i in range(5):
            self.storage.insert_telemetry(_msg(seq=i + 1))
        rows = self.storage.query_telemetry("EXO-S-001",
                                             "2026-07-30T00:00:00.000+08:00",
                                             "2026-07-30T23:59:59.000+08:00", 100)
        self.assertEqual(len(rows), 5)
        seqs = [r["sequence"] for r in rows]
        self.assertEqual(seqs, sorted(seqs))  # 按 ts 正序

    def test_export_slice(self):
        for i in range(3):
            self.storage.insert_telemetry(_msg(seq=i + 1, source_type="real"))
        sl = self.storage.export_slice("EXO-S-001",
                                        "2026-07-30T00:00:00.000+08:00",
                                        "2026-07-30T23:59:59.000+08:00")
        self.assertEqual(sl["record_count"], 3)
        self.assertEqual(sl["source_type"], "real")
        self.assertEqual(len(sl["records"]), 3)

    def test_insert_raw_frame(self):
        rid = self.storage.insert_raw_frame("EXO-S-001", "2026-07-30T10:00:00.000+08:00",
                                             1, 0x10, b"\xAA\x55\x14\x10", "real")
        self.assertTrue(rid)
        got = self.storage.get_raw_frame(rid)
        self.assertEqual(got["device_id"], "EXO-S-001")
        self.assertEqual(got["frame_type"], 0x10)
        self.assertEqual(got["raw_bytes"], b"\xAA\x55\x14\x10")

    def test_raw_ref_linkage(self):
        rid = self.storage.insert_raw_frame("EXO-S-001", "2026-07-30T10:00:00.000+08:00",
                                             1, 0x10, b"\x01\x02", "real")
        msg = _msg(seq=1, raw_ref=rid)
        self.storage.insert_telemetry(msg)
        latest = self.storage.latest_telemetry("EXO-S-001")
        self.assertEqual(latest["raw_ref"], rid)

    def test_insert_and_list_audit(self):
        aid = self.storage.insert_audit(actor="device:EXO-S-001", action="IDENT",
                                        object_type="device", object_id="EXO-S-001",
                                        after_json={"fw": "1.4.2"}, source_ip="127.0.0.1:9001")
        self.assertTrue(aid)
        logs = self.storage.list_audit(limit=10)
        self.assertEqual(len(logs), 1)
        self.assertEqual(logs[0]["action"], "IDENT")
        self.assertEqual(logs[0]["after"]["fw"], "1.4.2")
        # 按 action 过滤
        self.assertEqual(len(self.storage.list_audit(limit=10, action="IDENT")), 1)
        self.assertEqual(len(self.storage.list_audit(limit=10, action="FAULT")), 0)

    def test_upsert_device_with_model(self):
        self.storage.upsert_device(device_id="EXO-S-001", device_type="exoskeleton",
                                   model="NY-EXO-A1", device_model="NY-EXO-A1",
                                   firmware_version="1.4.2", protocol_version="NXP1-1.0",
                                   online=1, source_type="real",
                                   last_seen="2026-07-30T10:00:00.000+08:00")
        devs = self.storage.list_devices()
        self.assertEqual(len(devs), 1)
        self.assertEqual(devs[0]["device_model"], "NY-EXO-A1")
        self.assertEqual(devs[0]["protocol_version"], "NXP1-1.0")
        self.assertEqual(devs[0]["online"], 1)

    def test_mark_offline(self):
        self.storage.upsert_device(device_id="EXO-S-001", model="NY-EXO-A1",
                                   source_type="real", online=1,
                                   last_seen="2026-07-30T10:00:00.000+08:00")
        self.storage.mark_offline("EXO-S-001", "2026-07-30T10:01:00.000+08:00")
        dev = self.storage.list_devices()[0]
        self.assertEqual(dev["online"], 0)

    def test_counts_after_inserts(self):
        self.storage.upsert_person(person_id="P-1", display_name="测试员", team="A")
        self.storage.upsert_device(device_id="EXO-S-001", model="NY-EXO-A1",
                                   source_type="real")
        self.storage.insert_telemetry(_msg(seq=1))
        self.storage.insert_raw_frame("EXO-S-001", "2026-07-30T10:00:00.000+08:00",
                                      1, 0x10, b"\x01", "real")
        counts = self.storage.counts()
        self.assertEqual(counts["person"], 1)
        self.assertEqual(counts["device"], 1)
        self.assertEqual(counts["telemetry"], 1)
        self.assertEqual(counts["raw_frame"], 1)

    def test_reset_demo_preserves_real(self):
        # 写入 real + simulated 数据
        self.storage.insert_telemetry(_msg(seq=1, source_type="real"))
        self.storage.insert_telemetry(_msg(seq=2, source_type="simulated",
                                           device_id="EXO-SIM"))
        self.storage.upsert_device(device_id="EXO-SIM", model="NY-EXO-A1",
                                   source_type="simulated", online=1)
        self.storage.reset_demo()
        # real 保留，simulated 清除
        counts = self.storage.counts()
        self.assertEqual(counts["telemetry"], 1)  # 仅 real
        devs = self.storage.list_devices()
        sim_dev = next((d for d in devs if d["device_id"] == "EXO-SIM"), None)
        self.assertIsNotNone(sim_dev)
        self.assertEqual(sim_dev["online"], 0)  # simulated 设备被置离线

    def test_persistence_across_reopen(self):
        self.storage.insert_telemetry(_msg(seq=1))
        self.storage.close()
        # 重新打开同一 DB
        self.storage = Storage(self.db)
        latest = self.storage.latest_telemetry("EXO-S-001")
        self.assertIsNotNone(latest)
        self.assertEqual(latest["device_model"], "NY-EXO-A1")


if __name__ == "__main__":
    unittest.main()
