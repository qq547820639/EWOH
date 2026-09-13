"""多源传感器帧契约测试（2026-09-10 边缘韧性收口）。

覆盖三类真实缺陷的回归：
1. **非外骨骼帧本地丢弃**：环境/摄像头/定位帧此前原样透传给
   `storage.insert_telemetry`（要求 record_id/device_id/timestamp/source_type），
   必然 KeyError → 帧只留在 ERROR 日志里（data-flow §4.4 记录断点）。
   现在统一走 `normalize_frame`：本地行 + 平台上行载荷，字段名按契约映射。
2. **设备不在册**：非外骨骼设备的 `device` 行从未建立 →
   `UPDATE device SET last_seen/online` 命中 0 行 → 设备清单里看不到它。
   现在首次出现即 `ensure_device` 自动登记（model 未知写 unknown，不编造）。
3. **不可归一化帧静默消失**：现在一律进死信表 + 计数 + health 降级标记。

另外锁定两条诚信规则：`quality_status` 缺失 → `unknown`（绝不默认 good）、
`source_type` 缺失 → `unknown`（绝不默认 real）。

纯 Python 标准库 + unittest（与其它边缘测试同风格）。
"""

import os
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.edge.adapters.base import BaseAdapter
from edge_platform.edge.bus import MessageBus
from edge_platform.edge.frame_errors import FrameContractError
from edge_platform.edge.manager import AdapterManager
from edge_platform.edge.modeling.sensor_frames import (
    FRAME_KIND_ENVIRONMENT,
    FRAME_KIND_EXOSKELETON,
    FRAME_KIND_LOCATION,
    detect_frame_kind,
    normalize_frame,
)
from edge_platform.edge.storage import Storage
from edge_platform.runtime.protocols import STREAM_SENSOR_FRAMES, STREAM_TELEMETRY


def _iso() -> str:
    return datetime.now(timezone.utc).isoformat()


ENV_FRAME = {
    "sensor_id": "ENV-1",
    "station_id": "ST-01",
    "temperature_c": 24.5,
    "vibration_mm_s": 1.2,
    "noise_db": 61.0,
    "air_quality_pm25": 12.0,
    "ts": "2026-09-10T12:00:00.000Z",
    "source_type": "simulated",
    "quality_status": "good",
}

CAMERA_FRAME = {
    "camera_id": "CAM-1",
    "persons": [
        {"track_id": "T-1", "skeleton_json": '{"l_elbow": 90}', "bbox_xyxy": [1, 2, 11, 22], "confidence": 0.9},
        {"track_id": "T-2", "confidence": 0.8},
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
    "beacon_ids": ["B1", "B2"],
}

EXO_GROUPED_FRAME = {
    "entity_id": "EXO-1",
    "worker_id": "P-001",
    "event_time": "2026-09-10T12:00:00.000Z",
    "source_type": "simulated",
    "sequence": 7,
    "pose": {"pitch_deg": 12.0, "joint_angles_deg": {"l_elbow": 88}},
    "load": {"cumulative_load_score": 0.42, "torque_nm": 8.0},
    "device": {"battery_pct": 88, "temperature_c": 31.0},
    "quality": {"status": "good", "confidence": 0.97},
}


class FrameNormalizeTest(unittest.TestCase):
    """归一化：本地行 + 平台上行载荷 + 显式契约错误。"""

    def test_environment_maps_to_local_row_and_platform_dto(self):
        n = normalize_frame(ENV_FRAME)
        self.assertEqual(n["kind"], FRAME_KIND_ENVIRONMENT)
        self.assertEqual(n["device_id"], "ENV-1")

        row = n["local_row"]
        # 本地行讲边缘统一帧词汇（temperature_c …）+ kind 标记
        self.assertEqual(row["telemetry"]["kind"], "environment")
        self.assertEqual(row["telemetry"]["temperature_c"], 24.5)
        self.assertEqual(row["source_type"], "simulated")
        self.assertEqual(row["quality"]["status"], "good")
        self.assertTrue(row["record_id"].startswith("edge:environment:"))
        self.assertLessEqual(len(row["record_id"]), 64)

        # 上行载荷讲平台 DTO 词汇（temperature/event_time/…）
        uplink = n["uplink"]
        self.assertEqual(uplink["endpoint"], "environment")
        self.assertFalse(uplink["batch"])
        payload = uplink["payload"]
        self.assertEqual(payload["temperature"], 24.5)
        self.assertEqual(payload["vibration"], 1.2)
        self.assertEqual(payload["noise"], 61.0)
        self.assertEqual(payload["air_quality"], 12.0)
        self.assertEqual(payload["event_time"], ENV_FRAME["ts"])
        # 语义映射：工位是环境读数的受影响对象
        self.assertEqual(payload["entity_id"], "ST-01")
        self.assertEqual(payload["record_id"], row["record_id"])

    def test_camera_persons_map_to_platform_detections(self):
        n = normalize_frame(CAMERA_FRAME)
        payload = n["uplink"]["payload"]
        self.assertEqual(n["uplink"]["endpoint"], "camera")
        self.assertEqual(len(payload["detections"]), 2)
        first = payload["detections"][0]
        self.assertEqual(first["class_name"], "person")
        self.assertEqual(first["track_id"], "T-1")
        self.assertEqual(first["bbox"], {"x": 1.0, "y": 2.0, "w": 10.0, "h": 20.0})
        self.assertEqual(first["skeleton"], {"l_elbow": 90})
        self.assertEqual(payload["detections"][1]["confidence"], 0.8)
        self.assertNotIn("issues", payload)
        # 本地行只存摘要计数（骨架细节走平台世界状态，不重复落本地库）
        self.assertEqual(n["local_row"]["telemetry"]["person_count"], 2)
        self.assertEqual(n["issues"], [])

    def test_location_attribution_and_unattributed_tag(self):
        n = normalize_frame(LOCATION_FRAME)
        payload = n["uplink"]["payload"]
        self.assertEqual(n["uplink"]["endpoint"], "location")
        self.assertEqual(payload["entity_id"], "P-001")
        self.assertEqual(payload["locator"], "uwb")
        # 物理标签 id 必须上行（否则平台无法把定位设备登记进台账）
        self.assertEqual(payload["tag_id"], "TAG-1")
        self.assertEqual((payload["x"], payload["y"], payload["z"]), (1.5, 2.5, 0.0))

        orphan = normalize_frame({**LOCATION_FRAME, "tag_id": "TAG-9", "person_id": None})
        self.assertEqual(orphan["uplink"]["payload"]["entity_id"], "tag:TAG-9")
        self.assertIn("unattributed_tag", orphan["issues"])

    def test_exoskeleton_grouped_keeps_platform_payload_and_local_pipeline_row(self):
        n = normalize_frame(EXO_GROUPED_FRAME)
        self.assertEqual(n["kind"], FRAME_KIND_EXOSKELETON)
        row = n["local_row"]
        self.assertEqual(row["device_id"], "EXO-1")
        self.assertEqual(row["person_id"], "P-001")
        self.assertEqual(row["telemetry"]["cumulative_load_score"], 0.42)
        self.assertEqual(row["source_type"], "simulated")
        # 上行仍用分组帧（平台 ExoskeletonFrameDto 讲分组词汇）
        self.assertTrue(n["uplink"]["batch"])
        self.assertEqual(n["uplink"]["endpoint"], "exoskeleton")
        self.assertEqual(n["uplink"]["payload"]["record_id"], row["record_id"])
        self.assertEqual(n["uplink"]["payload"]["device_id"], "EXO-1")

    def test_record_id_is_deterministic_and_payload_sensitive(self):
        first = normalize_frame(ENV_FRAME)["record_id"]
        second = normalize_frame(dict(ENV_FRAME))["record_id"]
        self.assertEqual(first, second, "同一帧重发必须得到同一 id（重放不双写的依据）")

        changed = normalize_frame({**ENV_FRAME, "temperature_c": 25.5})["record_id"]
        self.assertNotEqual(first, changed, "同一时间戳的不同读数必须区分")

        explicit = normalize_frame({**ENV_FRAME, "record_id": "rec-fixed"})["record_id"]
        self.assertEqual(explicit, "rec-fixed", "帧自带 record_id 时原样使用")

    def test_detect_kind_returns_none_for_unregistered_frame(self):
        self.assertIsNone(detect_frame_kind({"foo": "bar"}))
        self.assertIsNone(detect_frame_kind("not-a-frame"))
        with self.assertRaises(FrameContractError) as ctx:
            normalize_frame({"foo": "bar"})
        self.assertIn("未登记的帧类别", str(ctx.exception))
        self.assertIsNone(ctx.exception.kind)

    def test_contract_errors_name_missing_fields(self):
        with self.assertRaises(FrameContractError) as ctx:
            normalize_frame({**ENV_FRAME, "ts": None})
        self.assertEqual(ctx.exception.kind, FRAME_KIND_ENVIRONMENT)
        self.assertIn("ts", ctx.exception.missing)

        with self.assertRaises(FrameContractError) as ctx2:
            normalize_frame({**LOCATION_FRAME, "x": "left"})
        self.assertEqual(ctx2.exception.kind, FRAME_KIND_LOCATION)
        self.assertIn("x", ctx2.exception.missing)

    def test_quality_and_source_never_defaulted_to_good_or_real(self):
        bare_env = {k: v for k, v in ENV_FRAME.items() if k not in ("quality_status", "source_type")}
        n = normalize_frame(bare_env)
        self.assertEqual(n["local_row"]["quality"]["status"], "unknown")
        self.assertEqual(n["local_row"]["source_type"], "unknown")

    def test_environment_without_measurements_is_flagged_not_silently_normal(self):
        n = normalize_frame({
            "sensor_id": "ENV-EMPTY",
            "ts": _iso(),
            "source_type": "simulated",
            "temperature_c": None,
        })
        self.assertIn("no_measurements", n["issues"])
        self.assertEqual(n["local_row"]["quality"]["status"], "invalid")


class StorageDeadLetterTest(unittest.TestCase):
    """存储层：设备自动登记 + 严格契约 + 死信留痕。"""

    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.storage = Storage(self.path)
        self.storage.init_db()

    def tearDown(self):
        self.storage.close()
        for suffix in ("", "-wal", "-shm"):
            try:
                os.unlink(self.path + suffix)
            except OSError:
                pass

    def test_ensure_device_registers_and_is_idempotent(self):
        self.storage.ensure_device("CAM-1", "camera", "simulated")
        devices = {d["device_id"]: d for d in self.storage.list_devices()}
        self.assertIn("CAM-1", devices)
        self.assertEqual(devices["CAM-1"]["device_type"], "camera")
        # model 未知 → 显式 unknown（不编造型号）
        self.assertEqual(devices["CAM-1"]["model"], "unknown")

        # 已有登记不被覆盖（人工登记信息是权威）
        self.storage.ensure_device("CAM-1", "camera", "real", model="VendorCam-9000")
        devices = {d["device_id"]: d for d in self.storage.list_devices()}
        self.assertEqual(devices["CAM-1"]["model"], "unknown")
        self.assertEqual(devices["CAM-1"]["source_type"], "simulated")

    def test_insert_telemetry_rejects_missing_contract_fields(self):
        before = self.storage.counts()["telemetry"]
        with self.assertRaises(FrameContractError) as ctx:
            # 缺 source_type：旧实现是 KeyError（同归于尽），现在显式契约错误
            self.storage.insert_telemetry({
                "record_id": "r1", "device_id": "D1", "timestamp": _iso(), "telemetry": {},
            })
        self.assertIn("source_type", ctx.exception.missing)
        self.assertEqual(self.storage.counts()["telemetry"], before, "非法帧不得落库")

    def test_dead_letter_is_listed_counted_and_idempotent(self):
        self.assertEqual(self.storage.count_frame_dead_letters(), 0)
        entry = {
            "record_id": "dl-1",
            "device_id": "D-RAW",
            "kind": None,
            "reason": "未登记的帧类别",
            "payload": {"foo": "bar"},
            "source_type": None,
        }
        self.storage.insert_frame_dead_letter(entry)
        # 同一坏帧重复出现：仍只有一行（原因可更新），不会无限膨胀
        self.storage.insert_frame_dead_letter({**entry, "reason": "仍未登记"})
        self.assertEqual(self.storage.count_frame_dead_letters(), 1)
        rows = self.storage.list_frame_dead_letters(limit=10)
        self.assertEqual(rows[0]["dead_letter_id"], "dl-1")
        self.assertEqual(rows[0]["reason"], "仍未登记")
        self.assertIn("foo", rows[0]["payload_json"])


class _ScriptedAdapter(BaseAdapter):
    """按脚本吐帧的适配器（测试用）：帧用尽后返回 None。"""

    def __init__(self, device_id, frames, source_type="simulated"):
        super().__init__(device_id=device_id, source_type=source_type, model="scripted")
        self._frames = list(frames)

    def start(self):
        # 与具体适配器一致：自行置运行位（base.start 是抽象占位，不调用 super）
        self._running = True
        self._started_at = _iso()
        return True

    def stop(self):
        self._running = False
        return True

    def reconnect(self):
        return True

    def read_message(self, timeout=None):
        if self._frames:
            return self._frames.pop(0)
        time.sleep(min(0.01, timeout or 0.01))
        return None

    def health(self):
        return {"device_id": self.device_id, "status": "online"}


class ManagerMultiSourceTest(unittest.TestCase):
    """管理器：多源帧落库/分流/死信/健康（真实 Storage + 真实 MessageBus）。"""

    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.storage = Storage(self.path)
        self.storage.init_db()
        self.bus = MessageBus()
        self.manager = AdapterManager(storage=self.storage, bus=self.bus)

    def tearDown(self):
        self.manager.stop()
        self.storage.close()
        for suffix in ("", "-wal", "-shm"):
            try:
                os.unlink(self.path + suffix)
            except OSError:
                pass

    def _run_until(self, predicate, timeout=5.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if predicate():
                return True
            time.sleep(0.02)
        return predicate()

    def test_non_exo_frames_are_persisted_registered_and_routed(self):
        sensor_stream: list = []
        telemetry_stream: list = []
        self.bus.subscribe(STREAM_SENSOR_FRAMES, sensor_stream.append)
        self.bus.subscribe(STREAM_TELEMETRY, telemetry_stream.append)

        self.manager.register(_ScriptedAdapter("ENV-1", [dict(ENV_FRAME)]))
        self.manager.register(_ScriptedAdapter("CAM-1", [dict(CAMERA_FRAME)]))
        self.manager.register(_ScriptedAdapter("TAG-1", [dict(LOCATION_FRAME)]))
        self.manager.register(_ScriptedAdapter("EXO-1", [dict(EXO_GROUPED_FRAME)]))
        self.manager.start()

        self.assertTrue(
            self._run_until(lambda: self.storage.counts()["telemetry"] >= 4),
            "环境/摄像头/定位/外骨骼四类帧都必须落本地库（此前非外骨骼帧被丢弃）",
        )
        devices = {d["device_id"] for d in self.storage.list_devices()}
        for expected in ("ENV-1", "CAM-1", "TAG-1", "EXO-1"):
            self.assertIn(expected, devices, f"{expected} 应自动登记进设备清单")
        self.assertEqual(
            {d["device_id"]: d["device_type"] for d in self.storage.list_devices() if d["device_id"] in ("ENV-1", "CAM-1", "TAG-1")},
            {"ENV-1": "environment", "CAM-1": "camera", "TAG-1": "location"},
        )

        # 分流：
        # - STREAM_TELEMETRY 只发外骨骼本地行（推理管线/世界投影的既有输入形状不变）；
        # - STREAM_SENSOR_FRAMES 发全部类别的归一化信封（上行桥按 endpoint 路由，
        #   默认跳过外骨骼走 edge_to_spark 专用通道）。
        self.assertTrue(self._run_until(lambda: len(telemetry_stream) >= 1 and len(sensor_stream) >= 4))
        self.assertEqual({row["device_id"] for row in telemetry_stream}, {"EXO-1"})
        self.assertEqual(
            {row["device_id"] for row in sensor_stream}, {"ENV-1", "CAM-1", "TAG-1", "EXO-1"}
        )
        endpoints = {row["device_id"]: row["uplink"]["endpoint"] for row in sensor_stream}
        self.assertEqual(
            endpoints,
            {"ENV-1": "environment", "CAM-1": "camera", "TAG-1": "location", "EXO-1": "exoskeleton"},
        )
        # 本地行仍在信封里（可观测/可审计），且非外骨骼不声明批量端点
        env_envelope = next(row for row in sensor_stream if row["device_id"] == "ENV-1")
        self.assertEqual(env_envelope["local_row"]["telemetry"]["temperature_c"], 24.5)
        self.assertFalse(env_envelope["uplink"]["batch"])

        # 环境行落库内容可查（本地口径保留统一帧字段名 + kind 标记）
        latest = self.storage.latest_telemetry("ENV-1")
        self.assertEqual(latest["quality"]["status"], "good")
        self.assertEqual(latest["telemetry"]["temperature_c"], 24.5)
        self.assertEqual(latest["telemetry"]["kind"], "environment")

    def test_unmappable_frame_goes_to_dead_letter_and_degrades_health(self):
        bad = _ScriptedAdapter("BROKEN-1", [{"foo": "bar"}, dict(ENV_FRAME)])
        self.manager.register(bad)
        self.manager.start()

        self.assertTrue(
            self._run_until(lambda: self.storage.count_frame_dead_letters() >= 1),
            "不可归一化帧必须进死信表（绝不静默丢弃）",
        )
        rows = self.storage.list_frame_dead_letters()
        self.assertEqual(rows[0]["device_id"], "BROKEN-1")
        self.assertIn("未登记的帧类别", rows[0]["reason"])
        self.assertIn("foo", rows[0]["payload_json"])

        # 坏帧之后的好帧照常落库：单帧被拒不能让采集循环停摆
        self.assertTrue(self._run_until(lambda: self.storage.counts()["telemetry"] >= 1))

        health = {h["device_id"]: h for h in self.manager.health()}
        self.assertGreaterEqual(health["BROKEN-1"]["dead_lettered"], 1)
        self.assertEqual(health["BROKEN-1"]["status"], "degraded", "有帧被拒的设备不得显示为健康")
        self.assertGreaterEqual(self.manager.dead_lettered_total, 1)


if __name__ == "__main__":
    unittest.main()


class ActuatorFrameContractTest(unittest.TestCase):
    """NO-59b：执行机构（AGV/PLC）状态帧归一化。

    锁定的语义：
      1. `mode=actuator` 帧被识别为 actuator 类别，上行端点为 `/api/ingest/actuator`；
      2. 统一帧三段（device/motion/business）压平为平台 DTO 字段，**不泄漏厂商字段**；
      3. 状态不在封闭词表内 → `issues` 显式标记（平台侧 fail-closed 拒绝），绝不猜成 idle；
      4. 缺 device_id/ts → FrameContractError（调用方转死信，不静默丢弃）。
    """

    def _frame(self, **overrides):
        frame = {
            "mode": "actuator",
            "device_id": "AGV-01",
            "ts": "2026-09-12T02:00:00+00:00",
            "state": "moving",
            "motion": {"x": 1.0, "y": 2.0, "state": "moving"},
            "device": {"battery_pct": 88, "fault_code": None, "online": True},
            "business": {
                "current_task_id": "T-9",
                "target_station_id": "ST-1",
                "last_authorization_ref": "control:CR-9",
            },
            "source_type": "simulated",
            "record_id": "ACT-1",
        }
        frame.update(overrides)
        return frame

    def test_detect_and_uplink_payload(self):
        from edge_platform.edge.modeling.sensor_frames import FRAME_KIND_ACTUATOR

        frame = self._frame()
        self.assertEqual(detect_frame_kind(frame), FRAME_KIND_ACTUATOR)
        out = normalize_frame(frame)
        self.assertEqual(out["kind"], FRAME_KIND_ACTUATOR)
        self.assertEqual(out["device_id"], "AGV-01")
        self.assertEqual(out["uplink"]["endpoint"], "actuator")
        payload = out["uplink"]["payload"]
        self.assertEqual(payload["state"], "moving")
        self.assertEqual(payload["x"], 1.0)
        self.assertEqual(payload["y"], 2.0)
        self.assertEqual(payload["battery_pct"], 88)
        self.assertEqual(payload["current_task_id"], "T-9")
        self.assertEqual(payload["last_authorization_ref"], "control:CR-9")
        self.assertEqual(payload["source_type"], "simulated")
        # 统一帧的三段结构不进上行载荷（平台 DTO 是压平口径）
        self.assertNotIn("motion", payload)
        self.assertNotIn("business", payload)
        # 本地行仍是遥测形状（record_id/device_id/timestamp/telemetry/quality）
        self.assertEqual(out["local_row"]["device_id"], "AGV-01")
        self.assertEqual(out["local_row"]["telemetry"]["state"], "moving")

    def test_state_outside_vocabulary_is_flagged_not_guessed(self):
        out = normalize_frame(self._frame(state="teleporting"))
        self.assertTrue(any(issue.startswith("unknown_state:") for issue in out["issues"]))
        self.assertEqual(out["uplink"]["payload"]["state"], "teleporting")
        # 质量状态经 local_row 暴露（normalize_frame 的顶层不返回 status）
        self.assertEqual(out["local_row"]["quality"]["status"], "invalid")

    def test_missing_required_fields_raise(self):
        with self.assertRaises(FrameContractError):
            normalize_frame(self._frame(device_id=None))
        with self.assertRaises(FrameContractError):
            normalize_frame(self._frame(ts=None))

    def test_flat_frame_without_mode_is_still_detected(self):
        frame = self._frame()
        frame.pop("mode")
        frame.pop("motion")
        frame.pop("device")
        frame.pop("business")
        frame["ts"] = frame.pop("ts")
        frame["x"] = 3.0
        frame["y"] = 4.0
        out = normalize_frame(frame)
        self.assertEqual(out["kind"], "actuator")
        self.assertEqual(out["uplink"]["payload"]["x"], 3.0)

    def test_uplink_endpoint_registered(self):
        from edge_platform.edge.modeling.sensor_frames import SUPPORTED_FRAME_KINDS, UPLINK_ENDPOINTS

        self.assertIn("actuator", SUPPORTED_FRAME_KINDS)
        self.assertEqual(UPLINK_ENDPOINTS["actuator"], "actuator")
