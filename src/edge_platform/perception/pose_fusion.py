"""统一位置与姿态融合（感知融合层核心）。

对应 spec「感知融合层」之融合公式（在精神上实现）：
    人员状态 = UWB 位置 + 外骨骼 IMU 姿态 + 视觉骨架 + 工位语义 + 任务上下文

融合规则可解释（spec 要求）：
- UWB 与视觉同工位 -> 高置信（位置置信度加权平均 + 一致性奖励），质量 GOOD。
- UWB 与视觉工位不一致 -> ConflictDetector 产生传感器冲突事件；采纳高置信度源，
  整体置信度下降，质量 DEGRADED，并记录冲突。
- 仅 UWB -> 用 UWB 位置，质量 GOOD（基站数 < 3 时 DEGRADED）。
- 仅视觉 -> 用反投影地面位置，置信度较低，质量 DEGRADED。
- 二者皆无 -> 质量 UNKNOWN，pose 为 None。
- 姿态优先取视觉骨架，其次外骨骼 IMU 躯干俯仰角，皆无则为 None。

降级融合（spec「降级融合」场景）：摄像头不可用时 degrade_on_camera_lost 保留 UWB+IMU，
降低置信度并标记 DEGRADED，不中断输出。纯 Python 标准库实现。
"""

from dataclasses import dataclass, field
from typing import Optional, List

from edge_platform.spatial import Pose, now_iso
from .quality import (
    QualityStatus, SensorConflict, ConflictDetector, confidence_from_quality,
)
from .vision_adapter import VisionDetection, skeleton_to_posture, project_to_floor


@dataclass
class FusedState:
    """融合后的人员统一状态。

    unified_pose 为融合位置（Pose 或 None）；posture 为 ``{"trunk_pitch_deg", "lean"}``；
    binding 记录人员—设备—任务绑定；sources_used 为参与融合的来源标识列表
    （如 ``["uwb", "vision"]``）；conflict 记录本次融合产生的传感器冲突事件（无则 None）。
    """
    person_id: str
    device_id: str = ""
    task_id: str = ""
    unified_pose: Optional[Pose] = None
    posture: Optional[dict] = None
    current_action: str = "unknown"
    workstation_id: str = ""
    binding: dict = field(default_factory=dict)
    confidence: float = 0.0
    source_type: str = "real"
    quality_status: QualityStatus = QualityStatus.UNKNOWN
    ts: str = ""
    sources_used: List[str] = field(default_factory=list)
    conflict: Optional[SensorConflict] = None


class PoseFusion:
    """多源位置与姿态融合器。"""

    # 仅 UWB 时判定为 GOOD 所需的最少基站数
    MIN_BEACONS_FOR_GOOD = 3
    # 工位一致时的置信度一致性奖励
    AGREEMENT_BONUS = 0.05
    # 冲突时整体置信度乘数
    CONFLICT_CONFIDENCE_FACTOR = 0.7
    # 仅 UWB 且基站不足时的置信度乘数
    FEW_BEACON_FACTOR = 0.8

    def __init__(self, conflict_detector=None):
        self.conflict_detector = conflict_detector or ConflictDetector()

    def fuse(self, person_id, uwb_sample, vision_det, exo_imu,
             station_id_hint, task_ctx):
        """融合 UWB + 视觉 + 外骨骼 IMU + 工位/任务上下文，输出 FusedState。

        :param uwb_sample: UWB 读数字典 ``{x,y,z,confidence,ts,beacon_ids,station_id}``
            或 None。
        :param vision_det: VisionDetection 或 None。
        :param exo_imu: 外骨骼 IMU 字典，可含 ``trunk_pitch_deg``；或 None。
        :param station_id_hint: 工位语义提示（如工位签到）。
        :param task_ctx: 任务/相机标定上下文字典，可含
            ``device_id``/``task_id``/``current_action``/``camera_pose``/
            ``camera_height_m``/``fov_v_deg``/``vision_station_id``/``source_type``。
        :return: FusedState（按上述规则填充质量、置信度、冲突与姿态）。
        """
        task_ctx = task_ctx or {}
        ts = now_iso()
        device_id = task_ctx.get("device_id", "")
        task_id = task_ctx.get("task_id", "")
        current_action = task_ctx.get("current_action", "unknown")
        sources_used = []

        # --- UWB 位置 ---
        uwb_pos = None
        uwb_conf = 0.0
        uwb_station = None
        beacon_ids = []
        if uwb_sample:
            ux = float(uwb_sample.get("x", 0.0))
            uy = float(uwb_sample.get("y", 0.0))
            uz = float(uwb_sample.get("z", 0.0))
            uwb_conf = max(0.0, min(1.0, float(uwb_sample.get("confidence", 0.0))))
            uwb_pos = Pose(x=ux, y=uy, z=uz, source="uwb", confidence=uwb_conf)
            uwb_station = uwb_sample.get("station_id") or station_id_hint
            beacon_ids = list(uwb_sample.get("beacon_ids") or [])
            sources_used.append("uwb")

        # --- 视觉位置（反投影到地面）---
        vis_pos = None
        vis_conf = 0.0
        vision_station = None
        if vision_det is not None:
            camera_pose = task_ctx.get("camera_pose")
            camera_height_m = float(task_ctx.get("camera_height_m", 3.0))
            fov_v_deg = float(task_ctx.get("fov_v_deg", 70.0))
            if camera_pose is not None:
                proj = project_to_floor(
                    vision_det.bbox_xyxy, camera_pose, camera_height_m, fov_v_deg
                )
                if proj is not None:
                    vx, vy, vconf = proj
                    # 视觉置信度取反投影质量与检测置信度的较小值（保守）
                    det_conf = max(0.0, min(1.0, float(vision_det.confidence)))
                    vis_conf = min(vconf, det_conf)
                    vis_pos = Pose(x=vx, y=vy, z=0.0, source="vision",
                                   confidence=vis_conf)
                    vision_station = task_ctx.get("vision_station_id") or station_id_hint
                    sources_used.append("vision")

        # --- 融合决策 ---
        conflict = None
        unified_pose = None
        confidence = 0.0
        quality = QualityStatus.UNKNOWN
        resolved_station = uwb_station or vision_station or station_id_hint or ""

        if uwb_pos is not None and vis_pos is not None:
            # 两源齐备：检查工位冲突
            conflict = self.conflict_detector.check(
                person_id, uwb_station, vision_station, uwb_conf, vis_conf,
                uwb_pose=uwb_pos, vision_pose=vis_pos,
            )
            if conflict is not None:
                # 工位不一致：采纳高置信度源，整体降级
                if uwb_conf >= vis_conf:
                    unified_pose = uwb_pos
                    resolved_station = uwb_station
                else:
                    unified_pose = vis_pos
                    resolved_station = vision_station
                confidence = max(uwb_conf, vis_conf) * self.CONFLICT_CONFIDENCE_FACTOR
                unified_pose.confidence = confidence
                quality = QualityStatus.DEGRADED
                conflict.resolved_station_id = resolved_station
            else:
                # 工位一致：位置置信度加权平均 + 一致性奖励
                w_u = uwb_conf
                w_v = vis_conf
                w_sum = w_u + w_v
                if w_sum <= 0.0:
                    unified_pose = Pose(
                        x=uwb_pos.x, y=uwb_pos.y, z=uwb_pos.z,
                        source="uwb+vision", confidence=0.0,
                    )
                    base_conf = 0.0
                else:
                    fx = (uwb_pos.x * w_u + vis_pos.x * w_v) / w_sum
                    fy = (uwb_pos.y * w_u + vis_pos.y * w_v) / w_sum
                    fz = uwb_pos.z  # 视觉不提供 z，沿用 UWB
                    base_conf = (uwb_conf * w_u + vis_conf * w_v) / w_sum
                    unified_pose = Pose(x=fx, y=fy, z=fz, source="uwb+vision",
                                        confidence=base_conf)
                confidence = max(0.0, min(1.0, base_conf + self.AGREEMENT_BONUS))
                unified_pose.confidence = confidence
                quality = QualityStatus.GOOD
        elif uwb_pos is not None:
            # 仅 UWB
            unified_pose = uwb_pos
            confidence = uwb_conf
            if len(beacon_ids) < self.MIN_BEACONS_FOR_GOOD:
                quality = QualityStatus.DEGRADED
                confidence = uwb_conf * self.FEW_BEACON_FACTOR
            else:
                quality = QualityStatus.GOOD
            unified_pose.confidence = confidence
        elif vis_pos is not None:
            # 仅视觉：置信度较低，降级
            unified_pose = vis_pos
            confidence = vis_conf
            quality = QualityStatus.DEGRADED
        else:
            # 二者皆无
            quality = QualityStatus.UNKNOWN
            unified_pose = None
            confidence = 0.0

        # --- 姿态：视觉骨架优先，其次外骨骼 IMU ---
        posture = None
        if vision_det is not None and vision_det.skeleton_json:
            posture = skeleton_to_posture(vision_det.skeleton_json)
        if posture is None and exo_imu:
            pitch = exo_imu.get("trunk_pitch_deg") if isinstance(exo_imu, dict) else None
            if pitch is not None:
                p = float(pitch)
                lean = "upright" if p < 15.0 else ("leaning" if p < 45.0 else "bent")
                posture = {"trunk_pitch_deg": p, "lean": lean}

        # --- 人员—设备—任务绑定 ---
        binding = {
            "person_id": person_id,
            "device_id": device_id,
            "task_id": task_id,
            "workstation_id": resolved_station,
        }

        return FusedState(
            person_id=person_id,
            device_id=device_id,
            task_id=task_id,
            unified_pose=unified_pose,
            posture=posture,
            current_action=current_action,
            workstation_id=resolved_station,
            binding=binding,
            confidence=confidence,
            source_type=task_ctx.get("source_type", "real"),
            quality_status=quality,
            ts=ts,
            sources_used=sources_used,
            conflict=conflict,
        )

    def degrade_on_camera_lost(self, state):
        """摄像头不可用时的降级融合（spec「降级融合」场景）。

        保留 UWB + 外骨骼 IMU，移除视觉来源，按 DEGRADED 质量乘数降低置信度，
        刷新时间戳，不中断输出。
        """
        state.confidence = confidence_from_quality(QualityStatus.DEGRADED, state.confidence)
        state.quality_status = QualityStatus.DEGRADED
        state.sources_used = [s for s in state.sources_used if s != "vision"]
        state.ts = now_iso()
        if state.unified_pose is not None:
            state.unified_pose.confidence = state.confidence
        return state
