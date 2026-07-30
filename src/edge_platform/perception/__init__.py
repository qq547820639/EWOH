"""多传感器感知融合层：UWB + 外骨骼 IMU + 视觉骨架 -> 统一位置/姿态/质量/冲突。

对应 spec「感知融合层」：融合 UWB 坐标 + 外骨骼 IMU + 视觉检测骨架 + 设备状态 + 工位占用 +
MES 任务 + 环境信息，输出人员统一位置、人体姿态、当前动作、工位占用、人员—设备—任务绑定、
数据质量与置信度、异常冲突。融合规则可解释：UWB 与视觉同工位为高置信；不一致产生传感器冲突
事件；摄像头不可用自动降级到 UWB 与外骨骼数据继续推断并降低置信度（V0.8 实现）。

模块组成：
- quality：QualityStatus 质量分级、confidence_from_quality 置信度映射、
  SensorConflict 冲突事件与 ConflictDetector 检测器。
- uwb_fusion：fuse_uwb_positions 多帧置信度加权平均、estimate_uwb_confidence 置信度估计。
- vision_adapter：VisionDetection 结构化检测结果、skeleton_to_posture 骨架到姿态粗估、
  bbox_center、project_to_floor 像平面到地面的简单针孔反投影。
- pose_fusion：FusedState 统一状态与 PoseFusion 融合器（fuse / degrade_on_camera_lost）。

纯 Python 标准库实现，无 numpy；空间原语复用 edge_platform.spatial。
"""

from .quality import (
    QualityStatus, SensorConflict, ConflictDetector, confidence_from_quality,
)
from .uwb_fusion import (
    fuse_uwb_positions, estimate_uwb_confidence,
)
from .vision_adapter import (
    VisionDetection, skeleton_to_posture, bbox_center, project_to_floor,
)
from .pose_fusion import (
    FusedState, PoseFusion,
)

__all__ = [
    "QualityStatus", "confidence_from_quality",
    "SensorConflict", "ConflictDetector",
    "fuse_uwb_positions", "estimate_uwb_confidence",
    "VisionDetection", "skeleton_to_posture", "bbox_center", "project_to_floor",
    "FusedState", "PoseFusion",
]
