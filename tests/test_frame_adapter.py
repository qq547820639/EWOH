"""遥测帧格式适配测试（Batch 8.4，H2 修复回归）。

验证 unified_to_telemetry_row / is_grouped_frame：
1. 分组格式（to_storage_dict 产物）→ 扁平存储格式字段对齐；
2. 双格式判定（分组帧需转换、扁平帧透传）；
3. 缺失分组安全降级（无 KeyError）。
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from edge_platform.edge.exo_semantic import UnifiedExoFrame, to_storage_dict  # noqa: E402
from edge_platform.edge.modeling.frame_adapter import (  # noqa: E402
    is_grouped_frame,
    unified_to_telemetry_row,
)


def _make_grouped() -> dict:
    frame = UnifiedExoFrame(
        entity_id="EXO-001",
        worker_id="W-1",
        event_time="2026-08-08T08:00:00.000+00:00",
        source_type="real",
        pose={"trunk_pitch_deg": 28.4, "angular_velocity_dps": 12.3, "joint_angles_deg": None},
        load={"assist_level": 0.6, "torque_nm": 18.5, "cumulative_load_score": 0.42},
        device={"battery_pct": 85.0, "temperature_c": 31.0, "fault_code": None, "health": "ok"},
        quality={"packet_loss_pct": 0.0, "confidence": 0.98, "status": "good"},
        record_id="REC-1",
    )
    return to_storage_dict(frame)


class FrameAdapterTest(unittest.TestCase):
    def test_grouped_to_flat_field_alignment(self):
        grouped = _make_grouped()
        row = unified_to_telemetry_row(grouped)

        # 顶层字段对齐 storage.insert_telemetry 期望
        self.assertEqual(row["device_id"], "EXO-001")
        self.assertEqual(row["timestamp"], "2026-08-08T08:00:00.000+00:00")
        self.assertEqual(row["source_type"], "real")
        self.assertEqual(row["person_id"], "W-1")
        self.assertEqual(row["record_id"], "REC-1")

        # telemetry 嵌套对齐 features.py 消费键
        self.assertEqual(row["telemetry"]["pitch_deg"], 28.4)
        self.assertEqual(row["telemetry"]["torque_nm"], 18.5)
        self.assertEqual(row["telemetry"]["assist_level"], 0.6)
        self.assertEqual(row["telemetry"]["battery_pct"], 85.0)
        self.assertEqual(row["quality"]["status"], "good")
        self.assertEqual(row["quality"]["confidence"], 0.98)

    def test_is_grouped_frame_detects_both_formats(self):
        grouped = _make_grouped()
        self.assertTrue(is_grouped_frame(grouped))
        # 扁平格式（转换产物）不应被误判为分组帧
        flat = unified_to_telemetry_row(grouped)
        self.assertFalse(is_grouped_frame(flat))
        # 非 dict 安全
        self.assertFalse(is_grouped_frame(None))
        self.assertFalse(is_grouped_frame("raw"))

    def test_missing_groups_no_keyerror(self):
        row = unified_to_telemetry_row({"entity_id": "EXO-1", "event_time": "2026-01-01T00:00:00Z"})
        self.assertEqual(row["device_id"], "EXO-1")
        self.assertEqual(row["telemetry"], {})
        self.assertEqual(row["quality"]["status"], "good")  # 缺省 good

    def test_roundtrip_with_pipeline_consumer_keys(self):
        # 转换产物可被 features.extract_features 消费（关键键存在）
        row = unified_to_telemetry_row(_make_grouped())
        t = row["telemetry"]
        self.assertIn("pitch_deg", t)
        self.assertIn("torque_nm", t)
        self.assertIn("assist_level", t)


if __name__ == "__main__":
    unittest.main()
