"""数据质量、置信度映射与传感器冲突检测。

对应 spec「感知融合层」之「传感器冲突事件」场景：UWB 与视觉对同一人员的工位归属
不一致时，系统产生传感器冲突事件，记录冲突详情与各源置信度，不静默丢弃。

质量分级（QualityStatus）用于描述单次融合结果的可信程度，并映射为置信度乘数：
GOOD（高置信，可用）/ DEGRADED（降级，可用但置信下降）/ INVALID（无效，不可用）/
UNKNOWN（来源缺失，状态未知）。纯 Python 标准库实现。
"""

import enum
from dataclasses import dataclass, field
from typing import Optional

from edge_platform.spatial import new_id, now_iso


class QualityStatus(enum.Enum):
    """数据质量状态（值即字符串，便于序列化与跨语言对齐）。"""

    GOOD = "good"
    DEGRADED = "degraded"
    INVALID = "invalid"
    UNKNOWN = "unknown"


# 质量状态 -> 置信度乘数：GOOD 不折减，DEGRADED 显著折减，INVALID/UNKNOWN 大幅折减。
_QUALITY_MULTIPLIERS = {
    QualityStatus.GOOD: 1.0,
    QualityStatus.DEGRADED: 0.7,
    QualityStatus.INVALID: 0.2,
    QualityStatus.UNKNOWN: 0.3,
}


def confidence_from_quality(quality_status, base):
    """根据数据质量状态对基准置信度 ``base`` 应用乘数。

    :param quality_status: QualityStatus 或其字符串值（good/degraded/invalid/unknown）。
    :param base: 基准置信度（0..1），来自传感器或融合中间结果。
    :return: 折减后的置信度，钳制到 [0, 1]。
    """
    if isinstance(quality_status, str):
        quality_status = QualityStatus(quality_status)
    multiplier = _QUALITY_MULTIPLIERS.get(quality_status, 0.3)
    return max(0.0, min(1.0, float(base) * multiplier))


@dataclass
class SensorConflict:
    """传感器冲突事件：同一人员的 UWB 与视觉给出不一致的工位归属。

    sources 记录各源原始判断（source 标识 / station_id / confidence / pose），
    resolved_station_id 为融合后采纳的工位（融合策略填充），note 为可读说明。
    """

    conflict_id: str
    person_id: str
    ts: str
    sources: list[dict] = field(default_factory=list)
    resolved_station_id: Optional[str] = None
    note: str = ""


class ConflictDetector:
    """检测 UWB 与视觉的工位归属冲突。

    判定规则（对应 spec）：
    - 同工位 -> 高置信，无冲突。
    - 工位不一致且两侧置信度均高于阈值 -> 产生冲突事件。
    - 任一来源缺失 -> 降级模式，不判定冲突（返回 None）。
    - 任一来源置信度低于阈值 -> 不判定冲突（数据不足以信任）。
    """

    DEFAULT_MIN_CONFIDENCE = 0.5

    def __init__(self, min_confidence=DEFAULT_MIN_CONFIDENCE):
        self.min_confidence = float(min_confidence)

    def check(self, person_id, uwb_station, vision_station, uwb_conf, vision_conf, uwb_pose=None, vision_pose=None):
        """检查 UWB 与视觉工位归属是否冲突。

        :return: SensorConflict 当两侧工位不一致且置信度均达标；否则 None。
        """
        # 任一来源缺失 -> 降级模式，不判定冲突
        if uwb_station is None or vision_station is None:
            return None
        # 任一来源置信度过低 -> 数据不足以信任，不判定冲突
        try:
            uwb_c = float(uwb_conf)
            vis_c = float(vision_conf)
        except (TypeError, ValueError):
            return None
        if uwb_c < self.min_confidence or vis_c < self.min_confidence:
            return None
        # 工位一致 -> 无冲突
        if uwb_station == vision_station:
            return None
        # 工位不一致 -> 产生冲突事件，记录两侧详情，不静默丢弃
        sources = [
            {
                "source": "uwb",
                "station_id": uwb_station,
                "confidence": uwb_c,
                "pose": uwb_pose,
            },
            {
                "source": "vision",
                "station_id": vision_station,
                "confidence": vis_c,
                "pose": vision_pose,
            },
        ]
        return SensorConflict(
            conflict_id=new_id("CFL"),
            person_id=person_id,
            ts=now_iso(),
            sources=sources,
            resolved_station_id=None,
            note=(f"UWB 工位 {uwb_station} 与视觉工位 {vision_station} 不一致"),
        )
