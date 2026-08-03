"""MES/工单适配器包。

提供 MESAdapter 基类与 SimulatedMESAdapter 模拟实现，
以及 protocol.parse_work_order 厂商工单事件解析为统一语义工单消息。
"""

from edge_platform.edge.adapters.mes.adapter import (
    MESAdapter,
    SimulatedMESAdapter,
)
from edge_platform.edge.adapters.mes.protocol import parse_work_order

__all__ = [
    "MESAdapter",
    "SimulatedMESAdapter",
    "parse_work_order",
]
