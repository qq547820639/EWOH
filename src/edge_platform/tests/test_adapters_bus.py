"""多传感器适配器 + 外骨骼统一语义 + 进程内消息总线 单元测试（Task 7 / 8.1 / 9）。

覆盖：
- 各模拟适配器产出统一语义消息（source_type/必填字段）。
- exo_semantic map_vendor_to_unified：厂商字段不泄漏；round-trip 等于原帧。
- MessageBus：publish/subscribe 顺序投递；tail 最近 N；range 按 ts 过滤；环形缓冲 cap 丢最旧。

纯 Python 标准库实现，使用 unittest。
"""

import os
import sys
import threading
import unittest

# 支持 PYTHONPATH=src 与直接运行两种方式
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.edge.adapters.base import BaseAdapter
from edge_platform.edge.adapters.uwb import (
    UWBBeacon, UWBTag, UWBAdapter, SimulatedUWBAdapter, parse_uwb_frame,
)
from edge_platform.edge.adapters.camera import (
    CameraAsset, CameraAdapter, SimulatedCameraAdapter, parse_detection,
)
from edge_platform.edge.adapters.mes import (
    MESAdapter, SimulatedMESAdapter, parse_work_order,
)
from edge_platform.edge.adapters.environment import (
    EnvSensorAsset, EnvSensorAdapter, SimulatedEnvSensorAdapter, parse_env_reading,
)
from edge_platform.edge.exo_semantic import (
    UnifiedExoFrame, DATA_TIERS, TIER_FIELDS,
    TIER_DEVICE, TIER_MOTION, TIER_LOAD, TIER_BUSINESS,
    map_vendor_to_unified, to_storage_dict, from_storage_dict,
)
from edge_platform.edge.bus import MessageBus, STREAMS


# ---------- UWB ----------
class UWBSimulatedAdapterTest(unittest.TestCase):
    def setUp(self):
        self.adapter = SimulatedUWBAdapter(
            device_id="UWB-SIM-1", tag_id="TAG-1", person_id="P-001",
            path=[(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (1.0, 1.0, 0.0), (0.0, 1.0, 0.0)],
            beacons=[UWBBeacon("B1", 0.0, 0.0), UWBBeacon("B2", 5.0, 0.0),
                     UWBBeacon("B3", 0.0, 5.0)],
            hz=20.0,
        )

    def tearDown(self):
        self.adapter.stop()

    def test_source_type_simulated(self):
        self.adapter.start()
        msg = self.adapter.read_message(timeout=2.0)
        self.assertIsNotNone(msg)
        self.assertEqual(msg["source_type"], "simulated")

    def test_required_fields(self):
        self.adapter.start()
        msg = self.adapter.read_message(timeout=2.0)
        for k in ("tag_id", "person_id", "x", "y", "z",
                  "quality_status", "confidence", "ts", "source_type", "beacon_ids"):
            self.assertIn(k, msg, "缺失字段: %s" % k)
        self.assertEqual(msg["tag_id"], "TAG-1")
        self.assertEqual(msg["person_id"], "P-001")
        self.assertIsInstance(msg["beacon_ids"], list)
        self.assertEqual(msg["beacon_ids"], ["B1", "B2", "B3"])
        self.assertIn(msg["quality_status"], ("good", "degraded", "invalid", "unknown"))

    def test_health_and_device_info(self):
        self.adapter.start()
        h = self.adapter.health()
        self.assertEqual(h["status"], "online")
        self.assertEqual(h["source_type"], "simulated")
        self.assertEqual(h["type"], "uwb")
        di = self.adapter.device_info()
        self.assertEqual(di["device_id"], "UWB-SIM-1")
        self.assertEqual(di["type"], "uwb")
        self.assertEqual(di["beacon_count"], 3)

    def test_parse_uwb_frame_pos(self):
        raw = {"tag": "TAG-9", "person_id": "P-9", "pos_x": 3.2, "pos_y": 4.1,
               "pos_z": 0.0, "confidence": 0.9, "beacon_ids": ["B1", "B2"]}
        msg = parse_uwb_frame(raw)
        self.assertEqual(msg["tag_id"], "TAG-9")
        self.assertAlmostEqual(msg["x"], 3.2)
        self.assertAlmostEqual(msg["y"], 4.1)
        self.assertEqual(msg["quality_status"], "good")
        self.assertEqual(msg["beacon_ids"], ["B1", "B2"])

    def test_parse_uwb_frame_anchor_distances(self):
        beacons = [UWBBeacon("B1", 0.0, 0.0), UWBBeacon("B2", 5.0, 0.0)]
        raw = {"tag_id": "TAG-2", "anchor_distances": {"B1": 1.0, "B2": 1.0}}
        msg = parse_uwb_frame(raw, beacons=beacons)
        # 距离相等，应得到两锚点中点附近
        self.assertAlmostEqual(msg["x"], 2.5, places=1)
        self.assertEqual(msg["quality_status"], "good")
        self.assertEqual(sorted(msg["beacon_ids"]), ["B1", "B2"])

    def test_parse_uwb_frame_invalid(self):
        raw = {"tag_id": "TAG-3"}  # 无坐标无锚距
        msg = parse_uwb_frame(raw)
        self.assertEqual(msg["quality_status"], "invalid")

    def test_vendor_fields_not_leaked(self):
        raw = {"tag_id": "TAG-4", "pos_x": 1.0, "pos_y": 2.0,
               "vendor_internal": "should-not-leak", "raw_rssi": -55}
        msg = parse_uwb_frame(raw)
        self.assertNotIn("vendor_internal", msg)
        self.assertNotIn("raw_rssi", msg)

    def test_base_adapter_rejects_bad_source_type(self):
        with self.assertRaises(ValueError):
            BaseAdapter("X", source_type="bogus")


# ---------- Camera ----------
class CameraSimulatedAdapterTest(unittest.TestCase):
    def setUp(self):
        self.adapter = SimulatedCameraAdapter(
            camera_id="CAM-1", hz=20.0, track_ids=["P1", "P2"],
        )

    def tearDown(self):
        self.adapter.stop()

    def test_source_type_simulated(self):
        self.adapter.start()
        msg = self.adapter.read_message(timeout=2.0)
        self.assertIsNotNone(msg)
        self.assertEqual(msg["source_type"], "simulated")

    def test_required_fields(self):
        self.adapter.start()
        msg = self.adapter.read_message(timeout=2.0)
        for k in ("camera_id", "persons", "ts", "source_type", "model_version"):
            self.assertIn(k, msg, "缺失字段: %s" % k)
        self.assertEqual(msg["camera_id"], "CAM-1")
        self.assertIsInstance(msg["persons"], list)
        self.assertGreater(len(msg["persons"]), 0)
        for p in msg["persons"]:
            for k in ("track_id", "skeleton_json", "bbox_xyxy", "confidence"):
                self.assertIn(k, p)

    def test_health_and_device_info(self):
        self.adapter.start()
        self.assertEqual(self.adapter.health()["type"], "camera")
        di = self.adapter.device_info()
        self.assertEqual(di["device_id"], "CAM-1")
        self.assertIn("model_version", di)

    def test_parse_detection(self):
        raw = {
            "camera_id": "CAM-2",
            "detections": [
                {"id": "T1", "skeleton": {"k": 1}, "bbox_xyxy": [1, 2, 3, 4], "score": 0.9},
                {"id": "T2", "keypoints": {"k": 2}, "bbox": [5, 6, 7, 8], "conf": 0.8},
            ],
            "ts": "2026-07-31T00:00:00.000+00:00",
            "vendor_meta": {"foo": "bar"},
        }
        msg = parse_detection(raw, default_model_version="mv-1")
        self.assertEqual(msg["camera_id"], "CAM-2")
        self.assertEqual(len(msg["persons"]), 2)
        self.assertEqual(msg["persons"][0]["track_id"], "T1")
        self.assertEqual(msg["persons"][0]["bbox_xyxy"], [1, 2, 3, 4])
        self.assertAlmostEqual(msg["persons"][0]["confidence"], 0.9)
        self.assertEqual(msg["model_version"], "mv-1")
        self.assertNotIn("vendor_meta", msg)


# ---------- MES ----------
class MESSimulatedAdapterTest(unittest.TestCase):
    def setUp(self):
        self.adapter = SimulatedMESAdapter(device_id="MES-SIM-1", hz=10.0)

    def tearDown(self):
        self.adapter.stop()

    def test_source_type_simulated(self):
        self.adapter.start()
        msg = self.adapter.read_message(timeout=2.0)
        self.assertIsNotNone(msg)
        self.assertEqual(msg["source_type"], "simulated")

    def test_required_fields(self):
        self.adapter.start()
        msg = self.adapter.read_message(timeout=2.0)
        for k in ("task_id", "task_name", "station_id", "required_skill",
                  "load_level", "status", "assigned_person_id", "ts", "source_type"):
            self.assertIn(k, msg, "缺失字段: %s" % k)
        self.assertIsNotNone(msg["task_id"])

    def test_parse_work_order(self):
        raw = {
            "wo_id": "WO-100", "name": "卸货", "station": "STN-1",
            "skill": "搬运", "load": 0.6, "state": "assigned",
            "worker_id": "P-5", "timestamp": "2026-07-31T01:00:00.000+00:00",
            "erp_internal_code": "X-99",  # 厂商私有，不应进入统一帧
        }
        msg = parse_work_order(raw)
        self.assertEqual(msg["task_id"], "WO-100")
        self.assertEqual(msg["task_name"], "卸货")
        self.assertEqual(msg["station_id"], "STN-1")
        self.assertEqual(msg["required_skill"], "搬运")
        self.assertAlmostEqual(msg["load_level"], 0.6)
        self.assertEqual(msg["status"], "assigned")
        self.assertEqual(msg["assigned_person_id"], "P-5")
        self.assertNotIn("erp_internal_code", msg)


# ---------- Environment ----------
class EnvSimulatedAdapterTest(unittest.TestCase):
    def setUp(self):
        self.adapter = SimulatedEnvSensorAdapter(
            sensor_id="ENV-1", station_id="STN-1", hz=20.0,
        )

    def tearDown(self):
        self.adapter.stop()

    def test_source_type_simulated(self):
        self.adapter.start()
        msg = self.adapter.read_message(timeout=2.0)
        self.assertIsNotNone(msg)
        self.assertEqual(msg["source_type"], "simulated")

    def test_required_fields(self):
        self.adapter.start()
        msg = self.adapter.read_message(timeout=2.0)
        for k in ("sensor_id", "station_id", "temperature_c", "vibration_mm_s",
                  "noise_db", "air_quality_pm25", "ts", "source_type", "quality_status"):
            self.assertIn(k, msg, "缺失字段: %s" % k)
        self.assertEqual(msg["sensor_id"], "ENV-1")
        self.assertEqual(msg["station_id"], "STN-1")
        self.assertIn(msg["quality_status"], ("good", "degraded", "invalid", "unknown"))

    def test_parse_env_reading(self):
        raw = {
            "dev_id": "ENV-2", "station": "STN-2",
            "temp_c": 25.5, "vibration": 1.2, "noise": 70.0, "pm25": 35.0,
            "timestamp": "2026-07-31T02:00:00.000+00:00",
            "vendor_meta": {"x": 1},  # 厂商私有，不应进入统一帧
        }
        msg = parse_env_reading(raw)
        self.assertEqual(msg["sensor_id"], "ENV-2")
        self.assertEqual(msg["station_id"], "STN-2")
        self.assertAlmostEqual(msg["temperature_c"], 25.5)
        self.assertAlmostEqual(msg["vibration_mm_s"], 1.2)
        self.assertAlmostEqual(msg["noise_db"], 70.0)
        self.assertAlmostEqual(msg["air_quality_pm25"], 35.0)
        self.assertEqual(msg["quality_status"], "good")
        self.assertNotIn("vendor_meta", msg)

    def test_parse_env_reading_invalid_when_empty(self):
        msg = parse_env_reading({"dev_id": "ENV-3"})
        self.assertEqual(msg["quality_status"], "invalid")


# ---------- 外骨骼统一语义 ----------
class ExoSemanticTest(unittest.TestCase):
    MAPPING = {
        "dev_id": "entity_id",
        "person_id": "worker_id",
        "ts": "event_time",
        "src": "source_type",
        "pitch_deg": "pose.trunk_pitch_deg",
        "gyro_dps": "pose.angular_velocity_dps",
        "joints": "pose.joint_angles_deg",
        "assist": "load.assist_level",
        "torque_nm": "load.torque_nm",
        "load_score": "load.cumulative_load_score",
        "battery": "device.battery_pct",
        "temp_c": "device.temperature_c",
        "fault": "device.fault_code",
        "health": "device.health",
        "loss_pct": "quality.packet_loss_pct",
        "conf": "quality.confidence",
    }

    def test_tiers_and_fields(self):
        self.assertEqual(DATA_TIERS, ("DEVICE", "MOTION", "LOAD", "BUSINESS"))
        for tier in DATA_TIERS:
            self.assertIn(tier, TIER_FIELDS)
            self.assertGreater(len(TIER_FIELDS[tier]), 0)
        # 抽查 spec 关键字段
        self.assertIn("battery_pct", TIER_FIELDS[TIER_DEVICE])
        self.assertIn("trunk_pitch", TIER_FIELDS[TIER_MOTION])
        self.assertIn("cumulative_load", TIER_FIELDS[TIER_LOAD])
        self.assertIn("current_task", TIER_FIELDS[TIER_BUSINESS])

    def test_vendor_fields_not_leaked(self):
        raw = {
            "dev_id": "EXO-001", "person_id": "P-001",
            "ts": "2026-07-31T08:30:00.000+00:00", "src": "real",
            "pitch_deg": 28.4, "gyro_dps": 12.3, "joints": {"left_knee": 45.0},
            "assist": 0.6, "torque_nm": 18.5, "load_score": 0.42,
            "battery": 78, "temp_c": 36.5, "fault": None, "health": "good",
            "loss_pct": 0.5, "conf": 0.92,
            # 厂商私有字段（不在 mapping 中），不应进入统一帧
            "vendor_secret": "ABC",
            "erp_internal_code": "X-99",
            "raw_imu_hex": "deadbeef",
        }
        frame = map_vendor_to_unified(raw, self.MAPPING)
        d = to_storage_dict(frame)
        # 厂商私有字段不应出现在顶层或任何分组
        for k in ("vendor_secret", "erp_internal_code", "raw_imu_hex"):
            self.assertNotIn(k, d, "厂商私有字段 %s 不应出现在顶层" % k)
            for grp in ("pose", "load", "device", "quality"):
                self.assertNotIn(k, d[grp], "厂商私有字段 %s 不应出现在 %s" % (k, grp))
        # 顶层只包含统一字段（不泄漏）
        self.assertEqual(set(d.keys()),
                         {"entity_id", "worker_id", "event_time",
                          "source_type", "pose", "load", "device", "quality"})
        # 统一字段已就位
        self.assertEqual(d["entity_id"], "EXO-001")
        self.assertEqual(d["worker_id"], "P-001")
        self.assertEqual(d["source_type"], "real")
        self.assertEqual(d["event_time"], "2026-07-31T08:30:00.000+00:00")
        self.assertAlmostEqual(d["pose"]["trunk_pitch_deg"], 28.4)
        self.assertAlmostEqual(d["pose"]["angular_velocity_dps"], 12.3)
        self.assertEqual(d["pose"]["joint_angles_deg"], {"left_knee": 45.0})
        self.assertAlmostEqual(d["load"]["assist_level"], 0.6)
        self.assertAlmostEqual(d["load"]["torque_nm"], 18.5)
        self.assertAlmostEqual(d["load"]["cumulative_load_score"], 0.42)
        self.assertEqual(d["device"]["battery_pct"], 78)
        self.assertAlmostEqual(d["device"]["temperature_c"], 36.5)
        self.assertIsNone(d["device"]["fault_code"])
        self.assertEqual(d["device"]["health"], "good")
        self.assertAlmostEqual(d["quality"]["packet_loss_pct"], 0.5)
        self.assertAlmostEqual(d["quality"]["confidence"], 0.92)

    def test_round_trip(self):
        raw = {
            "dev_id": "EXO-002", "person_id": "P-002",
            "ts": "2026-07-31T09:00:00.000+00:00", "src": "controlled_test",
            "pitch_deg": 15.0, "gyro_dps": 5.0, "joints": {"k": 1},
            "assist": 0.3, "torque_nm": 8.0, "load_score": 0.2,
            "battery": 50, "temp_c": 30.0, "fault": 0, "health": "degraded",
            "loss_pct": 1.5, "conf": 0.7,
        }
        frame = map_vendor_to_unified(raw, self.MAPPING)
        d = to_storage_dict(frame)
        frame2 = from_storage_dict(d)
        self.assertEqual(frame, frame2)
        # 二次往返稳定
        self.assertEqual(to_storage_dict(frame2), d)

    def test_storage_dict_matches_spec_example_shape(self):
        # 验证 to_storage_dict 输出形状匹配 spec 5.2 示例
        frame = UnifiedExoFrame(
            entity_id="EXO-001", worker_id="P-001",
            event_time="2026-07-31T08:30:00.000+00:00", source_type="real",
        )
        frame.pose = {"trunk_pitch_deg": 28.4, "angular_velocity_dps": 12.3,
                      "joint_angles_deg": {"left_knee": 45.0}}
        frame.load = {"assist_level": 0.6, "torque_nm": 18.5,
                      "cumulative_load_score": 0.42}
        frame.device = {"battery_pct": 78, "temperature_c": 36.5,
                        "fault_code": None, "health": "good"}
        frame.quality = {"packet_loss_pct": 0.5, "confidence": 0.92}
        d = to_storage_dict(frame)
        self.assertEqual(d["entity_id"], "EXO-001")
        self.assertEqual(d["pose"]["trunk_pitch_deg"], 28.4)
        self.assertEqual(d["load"]["torque_nm"], 18.5)
        self.assertEqual(d["device"]["health"], "good")
        self.assertEqual(d["quality"]["confidence"], 0.92)


# ---------- 消息总线 ----------
class MessageBusTest(unittest.TestCase):
    def test_streams(self):
        self.assertEqual(STREAMS, ("telemetry", "state", "events", "assets"))
        bus = MessageBus()
        self.assertEqual(set(bus.streams), set(STREAMS))

    def test_publish_subscribe_in_order(self):
        bus = MessageBus()
        received = []
        lock = threading.Lock()

        def handler(msg):
            with lock:
                received.append(msg["seq"])

        sub_id = bus.subscribe("events", handler)
        for i in range(5):
            bus.publish("events", {"seq": i,
                                   "ts": "2026-07-31T00:00:0%d.000+00:00" % i})
        self.assertEqual(received, [0, 1, 2, 3, 4])
        self.assertTrue(bus.unsubscribe("events", sub_id))
        # 取消后不再投递
        bus.publish("events", {"seq": 99})
        self.assertEqual(received, [0, 1, 2, 3, 4])

    def test_tail(self):
        bus = MessageBus(cap=1000)
        for i in range(10):
            bus.publish("telemetry",
                        {"seq": i, "ts": "2026-07-31T00:00:%02d.000+00:00" % i})
        tail3 = bus.tail("telemetry", 3)
        self.assertEqual([m["seq"] for m in tail3], [7, 8, 9])
        tail_all = bus.tail("telemetry", 100)
        self.assertEqual(len(tail_all), 10)
        self.assertEqual(tail_all[-1]["seq"], 9)
        self.assertEqual(bus.tail("telemetry", 0), [])

    def test_range_filters_by_ts(self):
        bus = MessageBus()
        msgs = [
            ("2026-07-31T00:00:00.000+00:00", 0),
            ("2026-07-31T00:00:01.000+00:00", 1),
            ("2026-07-31T00:00:02.000+00:00", 2),
            ("2026-07-31T00:00:03.000+00:00", 3),
            ("2026-07-31T00:00:04.000+00:00", 4),
        ]
        for ts, seq in msgs:
            bus.publish("events", {"ts": ts, "seq": seq})
        r = bus.range("events", "2026-07-31T00:00:01.000+00:00",
                      "2026-07-31T00:00:03.000+00:00")
        self.assertEqual([m["seq"] for m in r], [1, 2, 3])

    def test_ring_buffer_cap_drops_oldest(self):
        bus = MessageBus(cap=10)
        for i in range(15):
            bus.publish("state",
                        {"seq": i, "ts": "2026-07-31T00:00:%02d.000+00:00" % i})
        self.assertEqual(bus.length("state"), 10)
        all_msgs = bus.tail("state", 100)
        self.assertEqual([m["seq"] for m in all_msgs], list(range(5, 15)))

    def test_unknown_stream_raises(self):
        bus = MessageBus()
        with self.assertRaises(ValueError):
            bus.publish("unknown", {"x": 1})
        with self.assertRaises(ValueError):
            bus.subscribe("unknown", lambda m: None)
        with self.assertRaises(ValueError):
            bus.tail("unknown", 5)

    def test_subscribe_multiple_handlers(self):
        bus = MessageBus()
        a, b = [], []
        bus.subscribe("events", lambda m: a.append(m["seq"]))
        bus.subscribe("events", lambda m: b.append(m["seq"]))
        bus.publish("events", {"seq": 1, "ts": "2026-07-31T00:00:01.000+00:00"})
        self.assertEqual(a, [1])
        self.assertEqual(b, [1])

    def test_publish_auto_adds_ts(self):
        bus = MessageBus()
        bus.publish("telemetry", {"seq": 1})  # 未带 ts
        msgs = bus.tail("telemetry", 1)
        self.assertEqual(len(msgs), 1)
        self.assertIn("ts", msgs[0])
        self.assertTrue(msgs[0]["ts"])

    def test_handler_exception_does_not_break_bus(self):
        bus = MessageBus()
        good = []
        def bad(_):
            raise RuntimeError("boom")
        bus.subscribe("events", bad)
        bus.subscribe("events", lambda m: good.append(m["seq"]))
        # 不应抛异常
        bus.publish("events", {"seq": 1, "ts": "2026-07-31T00:00:01.000+00:00"})
        self.assertEqual(good, [1])
        # 总线仍可用
        bus.publish("events", {"seq": 2, "ts": "2026-07-31T00:00:02.000+00:00"})
        self.assertEqual(good, [1, 2])

    def test_rejects_non_positive_cap(self):
        with self.assertRaises(ValueError):
            MessageBus(cap=0)


if __name__ == "__main__":
    unittest.main()
