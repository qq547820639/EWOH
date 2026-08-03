"""Task 37 故障注入方法单元测试。

覆盖 WireInjector 新增的 5 个故障注入方法：
- timestamp_backwards：时间戳倒退帧；适配器质量层应判 timestamp_backward。
- timestamp_drift：时间戳漂移帧；超过阈值时适配器应判 timestamp_drift。
- nan_field：非数值字段；适配器 to_unified 直接路径应判 invalid，reason 含 non_numeric。
- sample_rate_anomaly：采样率异常帧流；窗口满后适配器应判 sampling_rate_anomaly。
- firmware_upgrade：固件升级 IDENT；适配器应记录 firmware_upgraded 事件并产出状态帧。

纯 Python 标准库 unittest；运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_fault_injection -v
"""

import os
import sys
import unittest

# 支持 PYTHONPATH=src 与直接运行两种方式
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.edge.adapters.ny_exo_a1 import codec, protocol  # noqa: E402
from edge_platform.edge.adapters.ny_exo_a1.adapter import NyExoA1Adapter  # noqa: E402
from edge_platform.edge.adapters.ny_exo_a1.injector import WireInjector  # noqa: E402


class TimestampBackwardsTest(unittest.TestCase):
    """timestamp_backwards：生成时间戳倒退帧，适配器质量层应判 timestamp_backward。"""

    def test_generates_valid_frame_with_earlier_ts(self):
        inj = WireInjector(device_id="EXO-TB-01", source_label="controlled_test", start_ts_ms=1_000_000, hz=20.0)
        # 先发一帧正常遥测建立基线
        first = inj.telemetry()
        # 再生成一帧 timestamp_backwards
        backward = inj.timestamp_backwards()
        self.assertEqual(len(backward), protocol.FRAME_OVERHEAD + protocol.TELEMETRY_PAYLOAD_LEN)
        frame, _ = protocol.decode_frame(backward)
        self.assertIsNotNone(frame)
        self.assertTrue(frame["crc_ok"])
        # 该帧 ts_ms 应小于上一帧（基线 ts_ms - 50ms）
        first_frame, _ = protocol.decode_frame(first)
        self.assertLess(frame["ts_ms"], first_frame["ts_ms"])

    def test_adapter_marks_timestamp_backward(self):
        inj = WireInjector(device_id="EXO-TB-02", source_label="controlled_test", start_ts_ms=1_000_000, hz=20.0)
        adapter = NyExoA1Adapter("EXO-TB-02", source_type="controlled_test")
        adapter.feed(inj.telemetry())
        adapter.feed(inj.timestamp_backwards())
        frames = adapter.drain()
        self.assertEqual(len(frames), 2)
        self.assertEqual(frames[1].quality["status"], "degraded")
        self.assertEqual(frames[1].quality["reason"], "timestamp_backward")

    def test_rewrite_existing_frame_bytes(self):
        inj = WireInjector(device_id="EXO-TB-03", start_ts_ms=1_000_000, hz=20.0)
        original = inj.telemetry()
        backward = inj.timestamp_backwards(frame_bytes=original)
        frame, _ = protocol.decode_frame(backward)
        self.assertTrue(frame["crc_ok"])
        # 重写后 ts_ms 应比原帧小至少一个周期
        orig_frame, _ = protocol.decode_frame(original)
        self.assertLess(frame["ts_ms"], orig_frame["ts_ms"])


class TimestampDriftTest(unittest.TestCase):
    """timestamp_drift：生成时间戳漂移帧，超过阈值时适配器应判 timestamp_drift。"""

    def test_generates_valid_frame_with_drifted_ts(self):
        inj = WireInjector(device_id="EXO-TD-01", start_ts_ms=1_000_000, hz=20.0)
        drifted = inj.timestamp_drift(drift_ms=1000)
        frame, _ = protocol.decode_frame(drifted)
        self.assertTrue(frame["crc_ok"])
        # 漂移 1000ms 后 ts_ms 应比基线大 1000
        self.assertGreaterEqual(frame["ts_ms"], 1_000_000 + 1000)

    def test_adapter_marks_timestamp_drift(self):
        inj = WireInjector(device_id="EXO-TD-02", start_ts_ms=1_000_000, hz=20.0)
        adapter = NyExoA1Adapter("EXO-TD-02", source_type="controlled_test")
        adapter.feed(inj.telemetry())
        # 漂移 1000ms 超过默认阈值 500ms
        adapter.feed(inj.timestamp_drift(drift_ms=1000))
        frames = adapter.drain()
        self.assertEqual(len(frames), 2)
        self.assertEqual(frames[1].quality["status"], "degraded")
        self.assertEqual(frames[1].quality["reason"], "timestamp_drift")

    def test_drift_within_threshold_not_flagged(self):
        inj = WireInjector(device_id="EXO-TD-03", start_ts_ms=1_000_000, hz=20.0)
        adapter = NyExoA1Adapter("EXO-TD-03", source_type="controlled_test")
        adapter.feed(inj.telemetry())
        # 漂移 100ms 在阈值 500ms 内 → 不降级
        adapter.feed(inj.timestamp_drift(drift_ms=100))
        frames = adapter.drain()
        self.assertEqual(len(frames), 2)
        self.assertEqual(frames[1].quality["status"], "good")
        self.assertIsNone(frames[1].quality["reason"])

    def test_invalid_drift_ms_raises(self):
        inj = WireInjector(device_id="EXO-TD-04", start_ts_ms=1_000_000)
        with self.assertRaises(ValueError):
            inj.timestamp_drift(drift_ms=0)
        with self.assertRaises(ValueError):
            inj.timestamp_drift(drift_ms="abc")  # type: ignore[arg-type]


class NanFieldTest(unittest.TestCase):
    """nan_field：非数值字段；协议层 i16 无法表达 NaN，编码为哨兵 0x7FFF（缺失）。

    NaN 物理量只能在适配器 ``to_unified`` 直接路径触发 non_numeric 检测
    （协议层不支持 NaN，但 backfill/未来路径可能引入，需防御性兜底）。
    """

    def test_generates_valid_frame_with_sentinel(self):
        inj = WireInjector(device_id="EXO-NaN-01", start_ts_ms=1_000_000)
        raw = inj.nan_field()
        frame, _ = protocol.decode_frame(raw)
        self.assertTrue(frame["crc_ok"])
        payload = protocol.parse_telemetry_payload(frame["payload"])
        # pitch_deg 被编码为哨兵 0x7FFF，解码后为 None（缺失）
        self.assertIsNone(payload["pitch_deg"])

    def test_adapter_to_unified_marks_invalid_for_nan(self):
        """NaN 物理量经 to_unified 直接路径应判 invalid，reason 含 non_numeric。"""
        adapter = NyExoA1Adapter("EXO-NaN-02", source_type="controlled_test")
        frame = adapter.to_unified({"pitch_deg": float("nan"), "torque_nm": 1.0, "battery_pct": 50}, ts_ms=1_000_000)
        self.assertEqual(frame.quality["status"], "invalid")
        self.assertEqual(frame.quality["confidence"], 0.0)
        self.assertTrue(frame.quality["reason"].startswith("non_numeric"))
        self.assertIn("pitch_deg", frame.quality["reason"])

    def test_nan_field_multiple_fields(self):
        adapter = NyExoA1Adapter("EXO-NaN-03", source_type="controlled_test")
        frame = adapter.to_unified(
            {"pitch_deg": float("nan"), "torque_nm": float("inf"), "battery_pct": 50, "roll_deg": 5.0}, ts_ms=1_000_000
        )
        self.assertEqual(frame.quality["status"], "invalid")
        reason = frame.quality["reason"]
        self.assertIn("pitch_deg", reason)
        self.assertIn("torque_nm", reason)

    def test_nan_field_existing_bytes_passthrough(self):
        inj = WireInjector(device_id="EXO-NaN-04", start_ts_ms=1_000_000)
        original = inj.telemetry()
        out = inj.nan_field(frame_bytes=original)
        # 已有帧字节不做改写，原样返回
        self.assertEqual(out, original)


class SampleRateAnomalyTest(unittest.TestCase):
    """sample_rate_anomaly：采样率异常帧流，窗口满后适配器应判 sampling_rate_anomaly。"""

    def test_generates_expected_frame_count(self):
        inj = WireInjector(device_id="EXO-SR-01", start_ts_ms=1_000_000, hz=20.0)
        raw = inj.sample_rate_anomaly(frames=11, actual_hz=10.0)
        frames = protocol.decode_stream(raw)
        self.assertEqual(len(frames), 11)
        for f in frames:
            self.assertTrue(f["crc_ok"])

    def test_adapter_marks_sampling_rate_anomaly(self):
        inj = WireInjector(device_id="EXO-SR-02", source_label="controlled_test", hz=10.0, start_ts_ms=1_000_000)
        adapter = NyExoA1Adapter("EXO-SR-02", source_type="controlled_test", sampling_window_ms=1000, expected_hz=20.0)
        raw = inj.sample_rate_anomaly(frames=11, actual_hz=10.0)
        adapter.feed(raw)
        frames = adapter.drain()
        self.assertEqual(len(frames), 11)
        # 第 11 帧窗口满且偏差超阈 → degraded
        self.assertEqual(frames[10].quality["status"], "degraded")
        self.assertEqual(frames[10].quality["reason"], "sampling_rate_anomaly")

    def test_invalid_args_raise(self):
        inj = WireInjector(device_id="EXO-SR-03", start_ts_ms=1_000_000)
        with self.assertRaises(ValueError):
            inj.sample_rate_anomaly(actual_hz=0)
        with self.assertRaises(ValueError):
            inj.sample_rate_anomaly(frames=0, actual_hz=10.0)

    def test_period_restored_after_call(self):
        inj = WireInjector(device_id="EXO-SR-04", start_ts_ms=1_000_000, hz=20.0)
        original_period = inj.period_ms
        inj.sample_rate_anomaly(frames=5, actual_hz=10.0)
        self.assertEqual(inj.period_ms, original_period)


class FirmwareUpgradeTest(unittest.TestCase):
    """firmware_upgrade：发新版本 IDENT，适配器应记录事件并产出状态帧。"""

    def test_generates_valid_ident_frame_with_new_version(self):
        inj = WireInjector(device_id="EXO-FW-01", start_ts_ms=1_000_000, firmware_version="1.0.0")
        raw = inj.firmware_upgrade(new_version="2.0.0")
        frame, _ = protocol.decode_frame(raw)
        self.assertEqual(frame["type"], protocol.TYPE_IDENT)
        self.assertTrue(frame["crc_ok"])
        ident = protocol.parse_ident_payload(frame["payload"])
        self.assertEqual(ident["firmware_version"], "2.0.0")

    def test_adapter_records_firmware_upgraded_event(self):
        adapter = NyExoA1Adapter("EXO-FW-02", source_type="controlled_test", firmware_version="1.0.0")
        inj = WireInjector(
            device_id="EXO-FW-02", source_label="controlled_test", start_ts_ms=1_000_000, firmware_version="1.0.0"
        )
        # 首发 IDENT 不触发（old_fw 已知，相同版本）
        adapter.feed(inj.ident())
        self.assertEqual(adapter.drain(), [])
        self.assertIsNone(adapter._firmware_upgraded)
        # 升级帧
        adapter.feed(inj.firmware_upgrade(new_version="2.0.0"))
        frames = adapter.drain()
        self.assertEqual(len(frames), 1)
        event = adapter._firmware_upgraded
        self.assertIsNotNone(event)
        self.assertEqual(event["firmware_from"], "1.0.0")
        self.assertEqual(event["firmware_to"], "2.0.0")
        self.assertEqual(event["event"], "firmware_upgraded")
        status = frames[0]
        self.assertEqual(status.quality.get("event"), "firmware_upgraded")
        self.assertEqual(status.quality.get("firmware_from"), "1.0.0")
        self.assertEqual(status.quality.get("firmware_to"), "2.0.0")
        # 适配器固件版本已更新
        self.assertEqual(adapter.firmware_version, "2.0.0")

    def test_rewrite_existing_ident_bytes(self):
        inj = WireInjector(device_id="EXO-FW-03", start_ts_ms=1_000_000, firmware_version="1.0.0")
        original = inj.ident()
        upgraded = inj.firmware_upgrade(frame_bytes=original, new_version="3.0.0")
        frame, _ = protocol.decode_frame(upgraded)
        self.assertEqual(frame["type"], protocol.TYPE_IDENT)
        ident = protocol.parse_ident_payload(frame["payload"])
        self.assertEqual(ident["firmware_version"], "3.0.0")

    def test_invalid_frame_bytes_raises(self):
        inj = WireInjector(device_id="EXO-FW-04", start_ts_ms=1_000_000, firmware_version="1.0.0")
        # 用一个 TELEMETRY 帧拒绝
        tel = codec.encode_telemetry(seq=1, ts_ms=1_000_000)
        with self.assertRaises(ValueError):
            inj.firmware_upgrade(frame_bytes=tel, new_version="2.0.0")


if __name__ == "__main__":
    unittest.main()
