"""EWOH 边缘推理包：滑窗特征 / 规则引擎 / 动作模型 / 推理管线 / 事件引擎 / 训练评测。

纯 Python 标准库实现；storage / bus 由上层按契约注入，本包不直接依赖具体实现。
"""

from datetime import datetime, timezone

SAMPLE_HZ = 20          # 标准遥测采样率
WINDOW_SEC = 2          # 推理滑窗长度（秒）
STEP_SEC = 1            # 推理滑窗步长（秒）


def ts_to_ms(ts):
    """ISO 8601 时间字符串 -> Unix 毫秒（UTC）。"""
    s = str(ts).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(round(dt.timestamp() * 1000))


def ms_to_ts(ms):
    """Unix 毫秒 -> ISO 8601（毫秒精度，UTC）。"""
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(timespec="milliseconds")


def new_id(prefix):
    """生成短随机业务 ID，如 INF-a1b2c3d4e5f6（uuid4 hex 前 12 位，碰撞概率足够低）。"""
    import uuid
    return "%s-%s" % (prefix, uuid.uuid4().hex[:12])


# 空间与上下文感知规则（算法第一阶段）与版本化注册表。
# 放在工具函数之后导入，避免与 spatial_rules 的 `from edge_platform.inference
# import ts_to_ms` 形成循环导入（此时 ts_to_ms / ms_to_ts / new_id 已定义）。
from .spatial_rules import (  # noqa: E402,F401
    RuleBase, RuleFinding,
    PostureThresholdRule, HighLoadDurationRule, ActionCountRule,
    BatteryPredictionRule, OfflineDetectionRule, StationDwellRule,
    TaskTimeoutRule, ZoneViolationRule, SensorConflictRule,
    CumulativeLoadIntegralRule,
)
from .rule_registry import RuleRegistry  # noqa: E402,F401
