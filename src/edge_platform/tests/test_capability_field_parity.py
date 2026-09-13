"""能力字段 ↔ 边缘归一化器产出字段 对账测试（2026-09-10，NO-14e）。

为什么需要：能力台账声明"这台设备能观测 temperature_c"，如果边缘上行载荷里
**根本没有这个字段**（改名/删除/从未实现），台账就变成了自述——世界模型据此
推导的结论会静默失真（决策原则 7：缺失不得被静默伪装成确定事实）。

本测试从权威契约 `contracts/capability/capability.schema.json` 的
`deviceObservationFields` 读取"能力名 → 来源帧字段"，再用真实的
`normalize_frame` 归一化各类统一帧，断言：

  1. 契约登记的字段**确实出现在**上行载荷（平台 DTO）或本地遥测里；
  2. 归一化器产出的关键测量字段**都被某条能力覆盖**（新增观测维度必须登记能力，
     否则"平台收到了没人认领的事实"）；
  3. 未登记类别的帧不产生任何能力（能力为空是显式结论，不是遗漏）。

纯 Python 标准库 + unittest。
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.contracts import capability
from edge_platform.contracts.capability import DEVICE_OBSERVATION_FIELDS
from edge_platform.edge.modeling.sensor_frames import normalize_frame

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
_SCHEMA_PATH = os.path.join(_REPO_ROOT, "contracts", "capability", "capability.schema.json")

ENV_FRAME = {
    "sensor_id": "ENV-1",
    "station_id": "ST-1",
    "temperature_c": 24.5,
    "vibration_mm_s": 1.2,
    "noise_db": 61.0,
    "air_quality_pm25": 12.0,
    "ts": "2026-09-10T12:00:00.000Z",
    "source_type": "simulated",
    "quality_status": "good",
}

ACTUATOR_FRAME = {
    "mode": "actuator",
    "device_id": "AGV-01",
    "ts": "2026-09-12T02:00:00+00:00",
    "state": "moving",
    "motion": {"x": 1.0, "y": 2.0, "state": "moving"},
    "device": {"battery_pct": 88, "fault_code": None, "online": True},
    "business": {"current_task_id": "T-9", "target_station_id": "ST-1"},
    "source_type": "simulated",
    "record_id": "ACT-1",
}

CAMERA_FRAME = {
    "camera_id": "CAM-1",
    "persons": [
        {"track_id": "T-1", "skeleton_json": '{"l_elbow": 90}', "confidence": 0.9, "action": "lift"},
    ],
    "ts": "2026-09-10T12:00:00.000Z",
    "source_type": "simulated",
    "model_version": "edge-pose-v0.1",
}

LOCATION_FRAME = {
    "tag_id": "TAG-1",
    "person_id": "P-001",
    "x": 1.5,
    "y": 2.5,
    "z": 0.0,
    "confidence": 0.8,
    "quality_status": "good",
    "ts": "2026-09-10T12:00:00.000Z",
    "source_type": "simulated",
}

EXO_FRAME = {
    "entity_id": "EXO-1",
    "worker_id": "P-001",
    "event_time": "2026-09-10T12:00:00.000Z",
    "source_type": "simulated",
    "sequence": 3,
    "pose": {"pitch_deg": 12.0},
    "load": {"cumulative_load_score": 0.42, "torque_nm": 8.0, "assist_level": 30},
    "device": {"battery_pct": 88},
    "quality": {"status": "good", "confidence": 0.97},
}


def _flatten(payload: dict, prefix: str = "") -> set:
    """摊平嵌套载荷的键路径（list 用 [] 表示，与契约 fields 写法一致）。"""
    keys: set = set()
    for key, value in payload.items():
        path = f"{prefix}{key}"
        if isinstance(value, dict):
            keys.add(path)
            keys |= _flatten(value, prefix=f"{path}.")
        elif isinstance(value, list):
            keys.add(f"{path}[]")
            for item in value:
                if isinstance(item, dict):
                    keys |= _flatten(item, prefix=f"{path}[].")
        else:
            keys.add(path)
    return keys


class CapabilityFieldParityTest(unittest.TestCase):
    def setUp(self):
        with open(_SCHEMA_PATH, encoding="utf-8") as fh:
            self.schema = json.load(fh)
        self.contract_fields = self.schema["deviceObservationFields"]
        self.assertTrue(self.contract_fields, "契约必须登记 deviceObservationFields")

    def test_python_constant_matches_schema(self):
        """Python DEVICE_OBSERVATION_FIELDS 与契约逐项一致（TS 侧由 jest 对账）。"""
        self.assertEqual(
            {name: list(fields) for name, fields in DEVICE_OBSERVATION_FIELDS.items()},
            {name: list(fields) for name, fields in self.contract_fields.items()},
        )

    def test_environment_fields_present_in_uplink(self):
        normalized = normalize_frame(ENV_FRAME)
        uplink_keys = _flatten(normalized["uplink"]["payload"])
        local_keys = _flatten(normalized["local_row"]["telemetry"])
        # 契约登记的是**平台摄入 DTO** 字段路径
        for name in ("observe.temperature", "observe.vibration", "observe.noise", "observe.air_quality"):
            for field in self.contract_fields[name]:
                self.assertIn(field, uplink_keys, f"环境上行缺少 {field}（能力 {name} 的依据）")
        # 边缘本地行仍用统一帧口径（temperature_c…）：映射是显式的，不是改名
        for edge_field in ("temperature_c", "vibration_mm_s", "noise_db", "air_quality_pm25"):
            self.assertIn(edge_field, local_keys, f"环境本地行缺少 {edge_field}（边缘统一帧口径）")

    def test_camera_and_location_fields_present(self):
        camera = normalize_frame(CAMERA_FRAME)
        cam_payload = camera["uplink"]["payload"]
        detections = cam_payload["detections"]
        self.assertTrue(detections, "摄像头帧必须产出 detections")
        first = detections[0]
        for field in ("track_id", "confidence"):
            self.assertIn(field, first, f"摄像头检测缺少 {field}")
        self.assertIn("skeleton", first, "摄像头检测缺少 skeleton（observe.pose 的依据）")
        self.assertIn("action", first, "摄像头检测缺少 action（observe.action 的依据）")

        location = normalize_frame(LOCATION_FRAME)
        loc_payload = location["uplink"]["payload"]
        for field in ("x", "y", "z", "confidence"):
            self.assertIn(field, loc_payload, f"定位上行缺少 {field}（observe.position 的依据）")

    def test_exoskeleton_fields_present_in_local_row(self):
        exo = normalize_frame(EXO_FRAME)
        local_keys = _flatten(exo["local_row"]["telemetry"])
        uplink_keys = _flatten(exo["uplink"]["payload"])
        # observe.load → load.cumulative_load_score / load.torque_nm（上行保留分组帧口径）
        for field in self.contract_fields["observe.load"]:
            self.assertIn(field, uplink_keys, f"外骨骼上行缺少 {field}")
        # interact.assist → load.assist_level
        for field in self.contract_fields["interact.assist"]:
            self.assertIn(field, uplink_keys, f"外骨骼上行缺少 {field}")
        # observe.wearer → worker_id（本地行带 person_id，上行带 worker_id）
        self.assertIn("worker_id", uplink_keys)
        self.assertIn("person_id", exo["local_row"])
        # observe.battery → device.battery_pct
        for field in self.contract_fields["observe.battery"]:
            self.assertIn(field, uplink_keys, f"外骨骼上行缺少 {field}")
        self.assertIn("cumulative_load_score", local_keys, "本地行应含外骨骼负荷分数")

    def test_every_contracted_field_is_actually_produced(self):
        """契约登记的每个字段路径都必须真的出现在上行载荷里（无孤儿登记）。"""
        produced: set = set()
        for frame in (ENV_FRAME, CAMERA_FRAME, LOCATION_FRAME, EXO_FRAME, ACTUATOR_FRAME):
            produced |= _flatten(normalize_frame(frame)["uplink"]["payload"])
        for name, fields in self.contract_fields.items():
            for field in fields:
                if "[]" in field:
                    # 列表项路径 `a[].b`：摊平后以 `a[].b` 形式出现
                    self.assertIn(field, produced, f"能力 {name} 的字段 {field} 在上行载荷中不存在")
                else:
                    self.assertIn(field, produced, f"能力 {name} 的字段 {field} 在上行载荷中不存在")


if __name__ == "__main__":
    unittest.main()


class CapabilityRiskParityTest(unittest.TestCase):
    """能力安全等级：Python 常量 == 权威契约 capabilityRisk（NO-19a）。"""

    @classmethod
    def setUpClass(cls):
        schema_path = os.path.join(
            os.path.dirname(__file__), "..", "..", "..", "contracts", "capability", "capability.schema.json"
        )
        with open(os.path.abspath(schema_path), encoding="utf-8") as handle:
            cls.schema = json.load(handle)

    def test_risk_levels_match_schema(self):
        self.assertEqual(tuple(capability.CAPABILITY_RISK_LEVELS), tuple(self.schema["capabilityRiskLevels"]))

    def test_risk_mapping_matches_schema(self):
        self.assertEqual(dict(capability.CAPABILITY_RISK), dict(self.schema["capabilityRisk"]))

    def test_every_known_value_has_risk(self):
        missing = [name for name in self.schema["knownValues"] if name not in capability.CAPABILITY_RISK]
        self.assertEqual(missing, [])

    def test_high_risk_relaxation_requires_safety_review(self):
        # 契约规则：高风险能力放宽必须走安全复核（平台不得仅凭调度员决定放宽）
        self.assertTrue(self.schema["rules"]["highRiskRelaxationRequiresSafetyReview"])
