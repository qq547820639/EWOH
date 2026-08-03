"""感知融合层单元测试：数据质量 / UWB 融合 / 视觉骨架 / 统一姿态融合 / 降级。

覆盖 spec「感知融合层」之「传感器冲突事件」与「降级融合」场景。纯标准库 unittest。
"""

import os
import sys
import unittest

# 支持 PYTHONPATH=src 与直接运行两种方式
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.perception import (
    ConflictDetector,
    PoseFusion,
    QualityStatus,
    SensorConflict,
    VisionDetection,
    estimate_uwb_confidence,
    fuse_uwb_positions,
    project_to_floor,
    skeleton_to_posture,
)
from edge_platform.spatial import Pose


# ---------- 测试夹具 ----------
def _uwb(x=5.0, y=5.0, z=0.0, conf=0.8, station="STN-A", beacons=None):
    return {
        "x": x,
        "y": y,
        "z": z,
        "confidence": conf,
        "ts": "2026-07-31T00:00:00.000+00:00",
        "beacon_ids": beacons if beacons is not None else ["B1", "B2", "B3", "B4"],
        "station_id": station,
    }


def _vision_det(bbox=(0.4, 0.6, 0.6, 0.95), skeleton=None, confidence=0.7, camera_id="CAM-1"):
    return VisionDetection(
        camera_id=camera_id,
        track_id="T1",
        bbox_xyxy=bbox,
        skeleton_json=skeleton or {},
        confidence=confidence,
        ts="2026-07-31T00:00:00.000+00:00",
        source_type="real",
        model_version="v0.1",
    )


def _task_ctx(camera_pose=None, vision_station="STN-A"):
    return {
        "device_id": "EXO-1",
        "task_id": "TASK-1",
        "camera_pose": camera_pose or Pose(x=5.0, y=0.0, z=3.0, yaw_deg=0.0),
        "camera_height_m": 3.0,
        "fov_v_deg": 70.0,
        "vision_station_id": vision_station,
        "current_action": "carrying",
        "source_type": "real",
    }


# ---------- ConflictDetector ----------
class ConflictDetectorTest(unittest.TestCase):
    def test_agree_no_conflict(self):
        cd = ConflictDetector()
        # 同工位 -> 无冲突
        self.assertIsNone(cd.check("P1", "STN-A", "STN-A", 0.8, 0.7))

    def test_disagree_records_both_sources(self):
        cd = ConflictDetector()
        c = cd.check("P1", "STN-A", "STN-B", 0.8, 0.7)
        self.assertIsNotNone(c)
        self.assertIsInstance(c, SensorConflict)
        self.assertEqual(c.person_id, "P1")
        # 两侧来源均被记录，不静默丢弃
        self.assertEqual(len(c.sources), 2)
        srcs = sorted(s["source"] for s in c.sources)
        self.assertEqual(srcs, ["uwb", "vision"])
        ids = {s["source"]: s["station_id"] for s in c.sources}
        self.assertEqual(ids["uwb"], "STN-A")
        self.assertEqual(ids["vision"], "STN-B")
        self.assertTrue(c.note)

    def test_one_source_missing_no_conflict(self):
        cd = ConflictDetector()
        # 任一来源缺失 -> 降级模式，不判定冲突
        self.assertIsNone(cd.check("P1", None, "STN-B", 0.0, 0.7))
        self.assertIsNone(cd.check("P1", "STN-A", None, 0.8, 0.0))

    def test_low_confidence_no_conflict(self):
        cd = ConflictDetector()
        # 任一来源置信度低于阈值 -> 不判定冲突
        self.assertIsNone(cd.check("P1", "STN-A", "STN-B", 0.3, 0.7))
        self.assertIsNone(cd.check("P1", "STN-A", "STN-B", 0.7, 0.4))


# ---------- fuse_uwb_positions / estimate_uwb_confidence ----------
class UwbFusionTest(unittest.TestCase):
    def test_weighted_average(self):
        samples = [
            {"x": 0.0, "y": 0.0, "z": 0.0, "confidence": 0.25},
            {"x": 10.0, "y": 4.0, "z": 1.0, "confidence": 0.75},
        ]
        fused = fuse_uwb_positions(samples)
        self.assertIsNotNone(fused)
        # (0*0.25 + 10*0.75) / 1.0 = 7.5
        self.assertAlmostEqual(fused["x"], 7.5, places=6)
        self.assertAlmostEqual(fused["y"], 3.0, places=6)  # (0*0.25 + 4*0.75)/1.0
        self.assertAlmostEqual(fused["z"], 0.75, places=6)
        self.assertGreater(fused["confidence"], 0.0)
        self.assertLessEqual(fused["confidence"], 1.0)

    def test_single_sample(self):
        fused = fuse_uwb_positions([{"x": 1.0, "y": 2.0, "z": 3.0, "confidence": 0.6}])
        self.assertIsNotNone(fused)
        self.assertAlmostEqual(fused["x"], 1.0)
        self.assertAlmostEqual(fused["y"], 2.0)

    def test_empty_returns_none(self):
        self.assertIsNone(fuse_uwb_positions([]))

    def test_all_zero_weights_returns_none(self):
        self.assertIsNone(
            fuse_uwb_positions(
                [
                    {"x": 1.0, "y": 1.0, "z": 0.0, "confidence": 0.0},
                ]
            )
        )

    def test_estimate_confidence_monotonic(self):
        # 基站越多置信度越高
        self.assertGreater(estimate_uwb_confidence(4, 0.0), estimate_uwb_confidence(2, 0.0))
        # 丢包越低置信度越高
        self.assertGreater(estimate_uwb_confidence(4, 0.0), estimate_uwb_confidence(4, 50.0))
        # 范围钳制
        for n in (0, 2, 4, 10):
            for loss in (0, 30, 70, 100):
                c = estimate_uwb_confidence(n, loss)
                self.assertGreaterEqual(c, 0.0)
                self.assertLessEqual(c, 1.0)


# ---------- skeleton_to_posture / project_to_floor ----------
class VisionAdapterTest(unittest.TestCase):
    def test_skeleton_upright_small_pitch(self):
        # neck 正上方 hip -> 倾角 0
        skel = {"hip": [100, 200, 0.9], "neck": [100, 100, 0.9]}
        p = skeleton_to_posture(skel)
        self.assertIsNotNone(p)
        self.assertLess(p["trunk_pitch_deg"], 15.0)
        self.assertEqual(p["lean"], "upright")

    def test_skeleton_bent_large_pitch(self):
        # neck 水平大幅偏离 hip 且仅略高 -> 大倾角
        skel = {"hip": [100, 200, 0.9], "neck": [180, 150, 0.9]}
        p = skeleton_to_posture(skel)
        self.assertIsNotNone(p)
        self.assertGreater(p["trunk_pitch_deg"], 45.0)
        self.assertEqual(p["lean"], "bent")

    def test_skeleton_incomplete_returns_none(self):
        self.assertIsNone(skeleton_to_posture({}))
        self.assertIsNone(skeleton_to_posture({"hip": [100, 200, 0.9]}))
        self.assertIsNone(skeleton_to_posture({"neck": [100, 100, 0.9]}))

    def test_bbox_center(self):
        from edge_platform.perception import bbox_center

        cx, cy = bbox_center((0.0, 0.0, 1.0, 1.0))
        self.assertAlmostEqual(cx, 0.5)
        self.assertAlmostEqual(cy, 0.5)
        cx, cy = bbox_center((10.0, 20.0, 30.0, 40.0))
        self.assertAlmostEqual(cx, 20.0)
        self.assertAlmostEqual(cy, 30.0)

    def test_project_to_floor_returns_world_xy(self):
        cam = Pose(x=5.0, y=0.0, z=3.0, yaw_deg=0.0)  # 朝正北
        res = project_to_floor((0.4, 0.6, 0.6, 0.95), cam, 3.0, 70.0)
        self.assertIsNotNone(res)
        wx, wy, conf = res
        # 朝正北 -> 投影点在相机前方（+Y 方向），y 增加
        self.assertGreater(wy, 0.0)
        self.assertGreater(conf, 0.0)
        self.assertLessEqual(conf, 1.0)

    def test_project_to_floor_feet_above_axis_returns_none(self):
        cam = Pose(x=0.0, y=0.0, z=3.0, yaw_deg=0.0)
        # 脚部在图像上半部（foot_y < 0.5）-> 无法投影
        self.assertIsNone(project_to_floor((0.4, 0.1, 0.6, 0.2), cam, 3.0, 70.0))


# ---------- PoseFusion ----------
class PoseFusionTest(unittest.TestCase):
    def setUp(self):
        self.pf = PoseFusion()

    def test_both_present_agree_high_confidence_good(self):
        uwb = _uwb(station="STN-A", conf=0.8)
        vd = _vision_det(confidence=0.7)
        ctx = _task_ctx(vision_station="STN-A")
        state = self.pf.fuse("P1", uwb, vd, None, "STN-A", ctx)
        self.assertEqual(state.quality_status, QualityStatus.GOOD)
        self.assertIsNone(state.conflict)
        self.assertIn("uwb", state.sources_used)
        self.assertIn("vision", state.sources_used)
        self.assertIsNotNone(state.unified_pose)
        self.assertGreater(state.confidence, 0.7)  # 高置信
        self.assertEqual(state.workstation_id, "STN-A")
        # 绑定关系
        self.assertEqual(state.binding["device_id"], "EXO-1")
        self.assertEqual(state.binding["task_id"], "TASK-1")

    def test_disagree_conflict_and_degraded(self):
        uwb = _uwb(station="STN-A", conf=0.8)
        vd = _vision_det(confidence=0.7)
        ctx = _task_ctx(vision_station="STN-B")  # 视觉落在 STN-B
        state = self.pf.fuse("P1", uwb, vd, None, "STN-A", ctx)
        self.assertEqual(state.quality_status, QualityStatus.DEGRADED)
        self.assertIsNotNone(state.conflict)
        self.assertEqual(len(state.conflict.sources), 2)
        # 采纳高置信度源（UWB 0.8 > 视觉）的工位
        self.assertEqual(state.conflict.resolved_station_id, "STN-A")
        self.assertEqual(state.workstation_id, "STN-A")
        # 冲突后置信度低于一致情形
        agree_state = self.pf.fuse(
            "P1",
            _uwb(station="STN-A", conf=0.8),
            _vision_det(confidence=0.7),
            None,
            "STN-A",
            _task_ctx(vision_station="STN-A"),
        )
        self.assertLess(state.confidence, agree_state.confidence)

    def test_only_uwb_good(self):
        uwb = _uwb(station="STN-A", conf=0.8, beacons=["B1", "B2", "B3", "B4"])  # 4 基站
        state = self.pf.fuse("P1", uwb, None, None, "STN-A", _task_ctx())
        self.assertEqual(state.quality_status, QualityStatus.GOOD)
        self.assertEqual(state.sources_used, ["uwb"])
        self.assertIsNotNone(state.unified_pose)
        self.assertAlmostEqual(state.unified_pose.x, 5.0)
        self.assertAlmostEqual(state.unified_pose.y, 5.0)
        self.assertIsNone(state.conflict)

    def test_only_uwb_few_beacons_degraded(self):
        uwb = _uwb(station="STN-A", conf=0.8, beacons=["B1", "B2"])  # 仅 2 基站
        state = self.pf.fuse("P1", uwb, None, None, "STN-A", _task_ctx())
        self.assertEqual(state.quality_status, QualityStatus.DEGRADED)
        self.assertLess(state.confidence, 0.8)

    def test_only_vision_degraded(self):
        vd = _vision_det(confidence=0.7)
        state = self.pf.fuse("P1", None, vd, None, "STN-A", _task_ctx(vision_station="STN-A"))
        self.assertEqual(state.quality_status, QualityStatus.DEGRADED)
        self.assertEqual(state.sources_used, ["vision"])
        self.assertIsNotNone(state.unified_pose)
        self.assertIsNone(state.conflict)

    def test_neither_unknown_pose_none(self):
        state = self.pf.fuse("P1", None, None, None, "STN-A", _task_ctx())
        self.assertEqual(state.quality_status, QualityStatus.UNKNOWN)
        self.assertIsNone(state.unified_pose)
        self.assertEqual(state.confidence, 0.0)
        self.assertEqual(state.sources_used, [])

    def test_posture_from_vision_skeleton(self):
        skel = {"hip": [100, 200, 0.9], "neck": [180, 150, 0.9]}  # 大前倾
        vd = _vision_det(skeleton=skel, confidence=0.7)
        state = self.pf.fuse("P1", _uwb(), vd, None, "STN-A", _task_ctx(vision_station="STN-A"))
        self.assertIsNotNone(state.posture)
        self.assertGreater(state.posture["trunk_pitch_deg"], 45.0)
        self.assertEqual(state.posture["lean"], "bent")

    def test_posture_falls_back_to_exo_imu(self):
        # 无视觉骨架，外骨骼 IMU 提供躯干俯仰角
        state = self.pf.fuse("P1", _uwb(), None, {"trunk_pitch_deg": 50.0}, "STN-A", _task_ctx())
        self.assertIsNotNone(state.posture)
        self.assertAlmostEqual(state.posture["trunk_pitch_deg"], 50.0)
        self.assertEqual(state.posture["lean"], "bent")

    def test_current_action_and_source_type(self):
        state = self.pf.fuse("P1", _uwb(), None, None, "STN-A", _task_ctx())
        self.assertEqual(state.current_action, "carrying")
        self.assertEqual(state.source_type, "real")


# ---------- degrade_on_camera_lost ----------
class DegradeOnCameraLostTest(unittest.TestCase):
    def test_confidence_drops_and_quality_degraded(self):
        pf = PoseFusion()
        # 先构建一个 UWB+视觉一致的 GOOD 状态
        state = pf.fuse(
            "P1",
            _uwb(station="STN-A", conf=0.8),
            _vision_det(confidence=0.7),
            None,
            "STN-A",
            _task_ctx(vision_station="STN-A"),
        )
        self.assertEqual(state.quality_status, QualityStatus.GOOD)
        self.assertIn("vision", state.sources_used)
        original_conf = state.confidence

        pf.degrade_on_camera_lost(state)

        self.assertEqual(state.quality_status, QualityStatus.DEGRADED)
        self.assertLess(state.confidence, original_conf)
        self.assertNotIn("vision", state.sources_used)
        self.assertIn("uwb", state.sources_used)
        # 仍保留输出，未中断
        self.assertIsNotNone(state.unified_pose)


if __name__ == "__main__":
    unittest.main()
