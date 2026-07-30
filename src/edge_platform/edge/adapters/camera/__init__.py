"""摄像头视觉适配器包。

提供 CameraAsset 资产、CameraAdapter 基类与 SimulatedCameraAdapter 模拟实现，
以及 protocol.parse_detection 厂商检测帧解析为统一语义骨架帧。
"""

from edge_platform.edge.adapters.camera.adapter import (
    CameraAsset, CameraAdapter, SimulatedCameraAdapter,
)
from edge_platform.edge.adapters.camera.protocol import parse_detection

__all__ = [
    "CameraAsset", "CameraAdapter", "SimulatedCameraAdapter",
    "parse_detection",
]
