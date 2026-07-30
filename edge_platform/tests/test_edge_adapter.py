"""NYExoA1Adapter 端到端测试（socketpair 模拟设备 TCP 连接）。

验证：IDENT 学习 device_id、TELEMETRY 入库含 Task 9 扩展字段、设备 online、
BACKFILL 补传去重、断连后离线、CRC 错误帧跳过。
"""
import os
import socket
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from edge.storage import Storage
from edge.bus import Bus
from edge.adapter import NYExoA1Adapter
from edge.protocol import (encode_ident, encode_telemetry, encode_heartbeat,
    encode_fault, encode_backfill, TYPE_IDENT, TYPE_TELEMETRY, TYPE_BACKFILL,
    TYPE_FAULT, DEVICE_MODEL, PROTOCOL_VERSION)

BASE_TS = 1756000000000
# device_id 限 8B ASCII（NXP1 IDENT 字段），测试统一用 8 字符 ID
DEV = "EXOT0001"


class AdapterTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.db = os.path.join(self.tmp, "test.db")
        self.storage = Storage(self.db)
        self.bus = Bus()
        # socketpair：a=平台侧（adapter），b=设备侧（测试驱动）
        self.a, self.b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        self.adapter = NYExoA1Adapter(
            self.a, ("test-client", 0), self.storage, self.bus, source_type="real")
        self.adapter.start()

    def tearDown(self):
        self.adapter.stop()
        self.b.close()
        self.a.close()
        self.storage.close()

    def _send(self, data):
        self.b.sendall(data)
        time.sleep(0.15)  # 等待 adapter 线程处理

    def _device(self, device_id):
        return next((d for d in self.storage.list_devices()
                     if d["device_id"] == device_id), None)


class IdentTelemetryTest(AdapterTestBase):
    def test_ident_learns_device_and_marks_online(self):
        self._send(encode_ident(DEV, "1.4.2", 0x23, seq=1, ts_ms=BASE_TS))
        dev = self._device(DEV)
        self.assertIsNotNone(dev)
        self.assertEqual(dev["online"], 1)
        self.assertEqual(dev["firmware_version"], "1.4.2")
        self.assertEqual(dev["device_model"], DEVICE_MODEL)
        self.assertEqual(dev["protocol_version"], PROTOCOL_VERSION)

    def test_telemetry_stored_with_task9_fields(self):
        self._send(encode_ident(DEV, "1.4.2", 0x23, seq=1, ts_ms=BASE_TS))
        self._send(encode_telemetry(2, BASE_TS + 50, 32.1, 2.4, 0, 0, 9810,
                                     1.2, 18.4, 0.6, 18.6, 45, 82))
        latest = self.storage.latest_telemetry(DEV)
        self.assertIsNotNone(latest)
        self.assertEqual(latest["device_model"], DEVICE_MODEL)
        self.assertEqual(latest["firmware_version"], "1.4.2")
        self.assertEqual(latest["protocol_version"], PROTOCOL_VERSION)
        self.assertIsNotNone(latest.get("raw_ref"))
        self.assertAlmostEqual(latest["telemetry"]["pitch_deg"], 32.1, places=1)
        self.assertAlmostEqual(latest["telemetry"]["torque_nm"], 18.6, places=1)
        self.assertEqual(latest["telemetry"]["battery_percent"], 82)
        self.assertEqual(latest["source_type"], "real")

    def test_raw_frame_linked(self):
        self._send(encode_ident(DEV, "1.4.2", 0x23, seq=1, ts_ms=BASE_TS))
        self._send(encode_telemetry(2, BASE_TS + 50, 10.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 80))
        latest = self.storage.latest_telemetry(DEV)
        raw = self.storage.get_raw_frame(latest["raw_ref"])
        self.assertIsNotNone(raw)
        self.assertEqual(raw["device_id"], DEV)
        self.assertTrue(len(raw["raw_bytes"]) > 0)

    def test_quality_status_set(self):
        self._send(encode_ident(DEV, "1.4.2", 0x23, seq=1, ts_ms=BASE_TS))
        self._send(encode_telemetry(2, BASE_TS + 50, 10.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 80))
        latest = self.storage.latest_telemetry(DEV)
        # 首条遥测 quality 应为 good 或至少有 status 字段
        self.assertIn(latest["quality"]["status"], ("good", "degraded", "invalid", "unknown"))


class BackfillTest(AdapterTestBase):
    def test_backfill_items_stored_and_dedup(self):
        self._send(encode_ident(DEV, "1.4.2", 0x23, seq=1, ts_ms=BASE_TS))
        # 先发一条正常遥测 seq=10
        self._send(encode_telemetry(10, BASE_TS, 10.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 80))
        # 补传 seq=10,11,12（10 应去重）
        items = [(s, BASE_TS + s * 50, {"pitch": 20.0, "torque": 8.0, "battery": 70})
                 for s in (10, 11, 12)]
        self._send(encode_backfill(100, BASE_TS + 5000, items))
        # 查询所有遥测，应有 seq=10(原) + 11,12(补传) = 3 条
        rows = self.storage.query_telemetry(
            DEV, "1970-01-01T00:00:00.000+00:00",
            "2099-01-01T00:00:00.000+00:00", 100)
        seqs = sorted(r["sequence"] for r in rows)
        self.assertIn(10, seqs)
        self.assertIn(11, seqs)
        self.assertIn(12, seqs)
        # seq=10 不应出现两次
        self.assertEqual(seqs.count(10), 1)


class FaultTest(AdapterTestBase):
    def test_fault_recorded_in_audit(self):
        self._send(encode_ident(DEV, "1.4.2", 0x23, seq=1, ts_ms=BASE_TS))
        self._send(encode_fault(5, BASE_TS + 100, 0x01, 0x00))
        audits = self.storage.list_audit(limit=10, action="FAULT")
        self.assertEqual(len(audits), 1)
        self.assertEqual(audits[0]["after"]["fault_name"], "IMU_FAULT")


class DisconnectTest(AdapterTestBase):
    def test_disconnect_marks_offline(self):
        self._send(encode_ident(DEV, "1.4.2", 0x23, seq=1, ts_ms=BASE_TS))
        dev = self._device(DEV)
        self.assertEqual(dev["online"], 1)
        # 关闭设备侧 -> adapter recv 返回 EOF -> 标记离线
        self.b.close()
        self.b = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)  # 占位避免 tearDown 报错
        time.sleep(0.3)
        dev = self._device(DEV)
        self.assertIsNotNone(dev)
        self.assertEqual(dev["online"], 0)


class CorruptFrameTest(AdapterTestBase):
    def test_crc_corrupt_frame_skipped(self):
        self._send(encode_ident(DEV, "1.4.2", 0x23, seq=1, ts_ms=BASE_TS))
        # 发送损坏帧（CRC 失败）+ 正常遥测帧
        bad = bytearray(encode_telemetry(2, BASE_TS + 50, 10.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 80))
        bad[16] ^= 0xFF
        good = encode_telemetry(3, BASE_TS + 100, 15.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 80)
        self._send(bytes(bad) + good)
        # 损坏帧应被跳过，仅 seq=3 入库
        rows = self.storage.query_telemetry(
            DEV, "1970-01-01T00:00:00.000+00:00",
            "2099-01-01T00:00:00.000+00:00", 100)
        seqs = [r["sequence"] for r in rows]
        self.assertIn(3, seqs)
        self.assertNotIn(2, seqs)


class BusPublishTest(AdapterTestBase):
    def test_telemetry_published_to_bus(self):
        sub = self.bus.subscribe("telemetry")
        self._send(encode_ident(DEV, "1.4.2", 0x23, seq=1, ts_ms=BASE_TS))
        self._send(encode_telemetry(2, BASE_TS + 50, 10.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 80))
        msg = sub.get(timeout=1.0)
        self.assertEqual(msg["device_id"], DEV)
        self.assertEqual(msg["device_model"], DEVICE_MODEL)

    def test_device_status_online_published(self):
        sub = self.bus.subscribe("device_status")
        self._send(encode_ident(DEV, "1.4.2", 0x23, seq=1, ts_ms=BASE_TS))
        msg = sub.get(timeout=1.0)
        self.assertEqual(msg["device_id"], DEV)
        self.assertEqual(msg["status"], "online")


if __name__ == "__main__":
    unittest.main()
