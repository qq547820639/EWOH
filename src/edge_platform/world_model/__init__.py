"""工厂世界模型：当前/历史状态、事件因果链、短期预测、回放。

对应 spec「工厂世界模型层」：以事件驱动结构维护当前状态、历史状态、实体关系、事件因果链、
短期预测与模型不确定性；事件链覆盖员工进入区域→与外骨骼绑定→领取任务→到达工位→开始搬运→
累计负荷上升→电量下降→工位积压→生成调度建议→班组长确认→任务重分配→结果回流；支持沿时间轴
回放事件、解释决策、评估改进效果（V0.9）。

模块组成：
- state_store：WorldState + StateStore，当前/历史状态与时间点查询。
- event_graph：EventNode/EventEdge/EventGraph + build_shift_chain，事件因果链。
- prediction：Prediction + Predictor，带不确定性的短期预测。
- replay：Replay，时间轴回放、状态对比、决策解释、班次摘要。

纯 Python 标准库实现；ID/时间戳沿用 edge_platform.spatial 与 edge_platform.inference 约定。
"""

from .state_store import WorldState, StateStore
from .event_graph import (
    EventNode, EventEdge, EventGraph, build_shift_chain,
    SHIFT_CHAIN_NODE_TYPES,
)
from .prediction import Prediction, Predictor, MODEL_VERSION
from .replay import Replay, NODE_TYPE_LABELS

__all__ = [
    "WorldState", "StateStore",
    "EventNode", "EventEdge", "EventGraph", "build_shift_chain",
    "SHIFT_CHAIN_NODE_TYPES",
    "Prediction", "Predictor", "MODEL_VERSION",
    "Replay", "NODE_TYPE_LABELS",
]
