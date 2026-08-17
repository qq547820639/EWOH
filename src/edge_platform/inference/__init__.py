"""EWOH 边缘推理包：滑窗特征 / 规则引擎 / 动作模型 / 推理管线 / 事件引擎 / 训练评测。

纯 Python 标准库实现；storage / bus 由上层按契约注入，本包不直接依赖具体实现。
"""

from datetime import datetime, timezone

SAMPLE_HZ = 20  # 标准遥测采样率
WINDOW_SEC = 2  # 推理滑窗长度（秒）
STEP_SEC = 1  # 推理滑窗步长（秒）


def ts_to_ms(ts):
    """ISO 8601 时间字符串 -> Unix 毫秒（UTC）。

    非法/缺失输入抛 ValueError（严格契约：调用方保证输入合法）。
    对外部遥测等不可信时间戳请用 ts_to_ms_safe（坏输入返回 None）。
    """
    s = str(ts).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(round(dt.timestamp() * 1000))


def ts_to_ms_safe(ts):
    """R2-ESC-004：ts_to_ms 的安全变体——非法/缺失时间戳返回 None 而非抛异常。

    供处理外部遥测记录（timestamp 可能缺失/畸形）的调用方按 None 防御：
    排序 key、聚合窗口等场景用 None 识别并跳过坏记录，不让单条坏数据
    中断整条开事件/聚合链路。
    """
    if ts is None:
        return None
    try:
        return ts_to_ms(ts)
    except (ValueError, TypeError, AttributeError):
        return None


def ms_to_ts(ms):
    """Unix 毫秒 -> ISO 8601（毫秒精度，UTC）。"""
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(timespec="milliseconds")


def new_id(prefix):
    """生成短随机业务 ID，如 INF-a1b2c3d4e5f6（uuid4 hex 前 12 位，碰撞概率足够低）。"""
    import uuid

    return f"{prefix}-{uuid.uuid4().hex[:12]}"


# 空间与上下文感知规则（算法第一阶段）与版本化注册表。
# 放在工具函数之后导入，避免与 spatial_rules 的 `from edge_platform.inference
# import ts_to_ms` 形成循环导入（此时 ts_to_ms / ms_to_ts / new_id 已定义）。
from .rule_registry import RuleRegistry  # noqa: E402,F401
from .spatial_rules import (  # noqa: E402,F401
    ActionCountRule,
    BatteryPredictionRule,
    CumulativeLoadIntegralRule,
    HighLoadDurationRule,
    OfflineDetectionRule,
    PostureThresholdRule,
    RuleBase,
    RuleFinding,
    SensorConflictRule,
    StationDwellRule,
    TaskTimeoutRule,
    ZoneViolationRule,
)
