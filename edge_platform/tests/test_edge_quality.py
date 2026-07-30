"""NY-EXO-A1 数据质量检查器单元测试。"""
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from edge.adapters.ny_exo_a1.quality import QualityChecker
from edge.adapters.base import (QUALITY_GOOD, QUALITY_DEGRADED, QUALITY_INVALID)

BASE_TS = 1756000000000


def _msg(seq=1, ts_ms=BASE_TS, pitch=10.0, torque=5.0, battery=80,
         fw="1.4.2", ingested_ms=None):
    from datetime import datetime, timezone
    ts = datetime.fromtimestamp(ts_ms / 1000.0, tz=timezone.utc).isoformat(timespec="milliseconds")
    ingested = (datetime.fromtimestamp(ingested_ms / 1000.0, tz=timezone.utc).isoformat(
        timespec="milliseconds") if ingested_ms else ts)
    return {
        "record_id": "rec-%d" % seq, "device_id": "EXO-Q-001",
        "timestamp": ts, "sequence": seq, "ingested_at": ingested,
        "firmware_version": fw, "telemetry": {
            "pitch_deg": pitch, "torque_nm": torque, "battery_percent": battery,
            "acceleration": [0.0, 0.0, 9.81]},
        "quality": {}, "source_type": "real",
    }


class QualityCheckerTest(unittest.TestCase):
    def setUp(self):
        self.qc = QualityChecker()

    def _status(self, msg):
        return msg["quality"]["status"]

    def _reasons(self, msg):
        return msg["quality"].get("reasons", [])

    def test_good_message(self):
        msg = self.qc.check("EXO-Q-001", _msg(seq=1))
        self.assertEqual(self._status(msg), QUALITY_GOOD)
        self.assertEqual(self._reasons(msg), [])

    def test_duplicate_sequence(self):
        self.qc.check("D1", _msg(seq=100))
        msg = self.qc.check("D1", _msg(seq=100, ts_ms=BASE_TS + 50))
        self.assertEqual(self._status(msg), QUALITY_DEGRADED)
        self.assertTrue(any("duplicate_sequence" in r for r in self._reasons(msg)))

    def test_sequence_gap(self):
        self.qc.check("D1", _msg(seq=100))
        msg = self.qc.check("D1", _msg(seq=120, ts_ms=BASE_TS + 50))
        self.assertTrue(any("sequence_gap" in r for r in self._reasons(msg)))
        self.assertEqual(self._status(msg), QUALITY_DEGRADED)

    def test_timestamp_regress(self):
        self.qc.check("D1", _msg(seq=100, ts_ms=BASE_TS + 1000))
        msg = self.qc.check("D1", _msg(seq=101, ts_ms=BASE_TS + 500))  # 时间倒退
        self.assertEqual(self._status(msg), QUALITY_INVALID)
        self.assertTrue(any("timestamp_regress" in r for r in self._reasons(msg)))

    def test_missing_field(self):
        msg = _msg(seq=1, torque=None)
        msg = self.qc.check("D1", msg)
        self.assertEqual(self._status(msg), QUALITY_INVALID)
        self.assertTrue(any("missing_field:torque_nm" in r for r in self._reasons(msg)))

    def test_out_of_range_pitch(self):
        msg = _msg(seq=1, pitch=185.0)
        msg = self.qc.check("D1", msg)
        self.assertEqual(self._status(msg), QUALITY_INVALID)
        self.assertTrue(any("out_of_range:pitch_deg" in r for r in self._reasons(msg)))

    def test_out_of_range_torque(self):
        msg = _msg(seq=1, torque=120.0)
        msg = self.qc.check("D1", msg)
        self.assertEqual(self._status(msg), QUALITY_INVALID)
        self.assertTrue(any("out_of_range:torque_nm" in r for r in self._reasons(msg)))

    def test_non_numeric(self):
        msg = _msg(seq=1)
        msg["telemetry"]["pitch_deg"] = "not a number"
        msg = self.qc.check("D1", msg)
        self.assertEqual(self._status(msg), QUALITY_INVALID)
        self.assertTrue(any("non_numeric" in r for r in self._reasons(msg)))

    def test_reconnect_duplicate(self):
        # 先发 seq 100-102，然后重连后重发 seq 100
        for s in (100, 101, 102):
            self.qc.check("D1", _msg(seq=s, ts_ms=BASE_TS + (s - 100) * 50))
        msg = self.qc.check("D1", _msg(seq=100, ts_ms=BASE_TS + 500))
        self.assertTrue(any("reconnect_duplicate" in r for r in self._reasons(msg)))
        self.assertEqual(self._status(msg), QUALITY_DEGRADED)

    def test_firmware_changed(self):
        self.qc.check("D1", _msg(seq=1, fw="1.4.2"))
        msg = self.qc.check("D1", _msg(seq=2, fw="1.5.0", ts_ms=BASE_TS + 50))
        self.assertTrue(any("firmware_changed" in r for r in self._reasons(msg)))
        self.assertEqual(self._status(msg), QUALITY_DEGRADED)

    def test_per_device_isolation(self):
        # D1 的状态不应影响 D2
        self.qc.check("D1", _msg(seq=100))
        msg_d2 = self.qc.check("D2", _msg(seq=100))  # D2 首条 seq=100 不应判 duplicate
        self.assertEqual(self._status(msg_d2), QUALITY_GOOD)

    def test_status_severity_ordering(self):
        # 同时有 invalid + degraded 原因 -> 取最严重 invalid
        self.qc.check("D1", _msg(seq=100, ts_ms=BASE_TS + 1000))
        msg = _msg(seq=100, ts_ms=BASE_TS + 500, torque=None, pitch=185.0)
        msg = self.qc.check("D1", msg)
        # duplicate_sequence(degraded) + timestamp_regress(invalid) + missing(invalid) + oor(invalid)
        self.assertEqual(self._status(msg), QUALITY_INVALID)

    def test_clock_drift(self):
        # 设备时间与入库时间偏差 > 200ms
        msg = _msg(seq=1, ts_ms=BASE_TS, ingested_ms=BASE_TS + 500)
        msg = self.qc.check("D1", msg)
        self.assertTrue(any("clock_drift" in r for r in self._reasons(msg)))


if __name__ == "__main__":
    unittest.main()
