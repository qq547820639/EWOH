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
    """生成短随机业务 ID，如 INF-a1b2c3d4。"""
    import uuid
    return "%s-%s" % (prefix, uuid.uuid4().hex[:8])
