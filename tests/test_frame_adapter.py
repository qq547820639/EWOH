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
        # 安全默认：缺 provenance/质量时不得猜测 good 或 real。
        self.assertEqual(row["quality"]["status"], "unknown")
        self.assertEqual(row["source_type"], "unknown")

    def test_roundtrip_with_pipeline_consumer_keys(self):
        # 转换产物可被 features.extract_features 消费（关键键存在）
        row = unified_to_telemetry_row(_make_grouped())
        t = row["telemetry"]
        self.assertIn("pitch_deg", t)
        self.assertIn("torque_nm", t)
        self.assertIn("assist_level", t)

    def test_sequence_backfill_firmware_passthrough(self):
        """E-05/E-07/E-10 回归：sequence / backfill / firmware_version 必须透传到扁平帧。"""
        frame = UnifiedExoFrame(
            entity_id="EXO-001",
            event_time="2026-08-08T08:00:00.000+00:00",
            firmware_version="fw-2.5.1",
            sequence=118,
            backfill=True,
        )
        row = unified_to_telemetry_row(to_storage_dict(frame))
        self.assertEqual(row["sequence"], 118, "SEQ 必须透传（乱序/补传/丢包溯源）")
        self.assertTrue(row["backfill"], "补传标记必须透传（规则层跳过时间戳倒退检测）")
        self.assertEqual(row["firmware_version"], "fw-2.5.1", "固件版本必须透传（推理白名单校验）")

    def test_backfill_defaults_false(self):
        frame = UnifiedExoFrame(entity_id="EXO-001", event_time="2026-08-08T08:00:00.000+00:00")
        row = unified_to_telemetry_row(to_storage_dict(frame))
        self.assertFalse(row["backfill"])
        self.assertEqual(row["sequence"], 0)


class RealDeviceChainTest(unittest.TestCase):
    """P0 端到端回归：NXP1 真机形状（无 roll/3D 角速度/3D 加速度）经全链路必须产出特征与真实标签。

    链路：UnifiedExoFrame（NXP1 形状）→ to_storage_dict → unified_to_telemetry_row
    → extract_features → InferencePipeline._rule_label。此前该链路 extract_features
    恒 None → 动作分类恒 unknown/data_quality 并引发 LOW_QUALITY 持续误报。
    """

    def _device_subset_row(self, entity_id, t_ms, pitch=10.0, gyro_dps=120.0, torque=8.0):
        from edge_platform.inference import ms_to_ts

        frame = UnifiedExoFrame(
            entity_id=entity_id,
            event_time=ms_to_ts(t_ms),
            source_type="real",
            pose={"trunk_pitch_deg": pitch, "angular_velocity_dps": gyro_dps, "joint_angles_deg": None},
            load={"assist_level": 0.2, "torque_nm": torque, "cumulative_load_score": None},
            device={"battery_pct": 80.0, "temperature_c": None, "fault_code": None, "health": "good"},
            quality={"packet_loss_pct": 0.0, "confidence": 0.95, "status": "good"},
        )
        return unified_to_telemetry_row(to_storage_dict(frame))

    def test_real_device_window_produces_features_and_walk_label(self):
        from edge_platform.inference.features import extract_features
        from edge_platform.inference.pipeline import InferencePipeline

        base = 1_800_000_000
        window = [
            self._device_subset_row("EXO-001", base + i * 50) for i in range(40)
        ]
        feats = extract_features(window)
        self.assertIsNotNone(feats, "真机通道子集必须产出特征（此前恒 None）")
        self.assertIsNone(feats["roll_mean"], "设备无 roll 通道")
        self.assertAlmostEqual(feats["gyro_mag_mean"], 120.0, places=6, msg="标量角速度模长折算 gyro_mag")
        label, conf, reason = InferencePipeline._rule_label(feats)
        self.assertEqual(label, "walk")
        self.assertIsNone(reason)

    def test_real_device_bend_label(self):
        from edge_platform.inference.features import extract_features
        from edge_platform.inference.pipeline import InferencePipeline

        base = 1_800_000_000
        window = [
            self._device_subset_row("EXO-001", base + i * 50, pitch=45.0, gyro_dps=10.0)
            for i in range(40)
        ]
        label, _, _ = InferencePipeline._rule_label(extract_features(window))
        self.assertEqual(label, "bend")


if __name__ == "__main__":
    unittest.main()
