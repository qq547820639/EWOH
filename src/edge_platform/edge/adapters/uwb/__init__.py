"""UWB 定位适配器包。

提供 UWBBeacon / UWBTag 资产、UWBAdapter 基类与 SimulatedUWBAdapter 模拟实现，
以及 protocol.parse_uwb_frame 厂商帧解析为统一语义位置消息。
"""

from edge_platform.edge.adapters.uwb.adapter import (
    UWBBeacon, UWBTag, UWBAdapter, SimulatedUWBAdapter,
)
from edge_platform.edge.adapters.uwb.protocol import parse_uwb_frame

__all__ = [
    "UWBBeacon", "UWBTag", "UWBAdapter", "SimulatedUWBAdapter",
    "parse_uwb_frame",
]
