"""NY-EXO-A1 数据质量检查器（Task 10）。

维护 per-device 状态，对每条标准消息执行序号/时间戳/字段/量程/采样率等
异常检测，输出 quality.status（good/degraded/invalid）与 reasons 列表。

严重度排序：invalid > degraded > good。
- invalid：数据本身错误或不可信（字段缺失/越界/非数值/时间倒退）
- degraded：数据可疑但仍可用（序号重复/跳变/时钟漂移/采样率异常/补传重复/固件变更）
"""
import collections
from datetime import datetime, timezone

from ..base import (QUALITY_GOOD, QUALITY_DEGRADED, QUALITY_INVALID, QUALITY_UNKNOWN)

# 判定为 invalid 的 reason 前缀（数据本身错误，不应进入推理）
_INVALID_PREFIXES = ("missing_field", "out_of_range", "non_numeric", "timestamp_regress")


def _ts_to_ms(ts_iso):
    """ISO 8601 时间字符串 -> epoch ms。非法/空返回 None。"""
    if not ts_iso:
        return None
    s = str(ts_iso).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(round(dt.timestamp() * 1000))
    except (ValueError, OverflowError, OSError):
        return None


class QualityChecker:
    """per-device 数据质量检查器。

    状态字段（per device_id）：
      last_seq / last_ts_ms / firmware_version / recent_seqs(deque maxlen=300) /
      last_interval_ms
    """

    def __init__(self):
        self._state = {}

    def _state_for(self, device_id):
        return self._state.setdefault(device_id, {
            "last_seq": None,
            "last_ts_ms": None,
            "firmware_version": None,
            "recent_seqs": collections.deque(maxlen=300),
            "last_interval_ms": None,
        })

    def check(self, device_id, message):
        """对 message 执行质量检查，填入 quality.status 与 reasons，返回 message。"""
        st = self._state_for(device_id)
        tele = message.get("telemetry") or {}
        seq = message.get("sequence")
        ts_ms = _ts_to_ms(message.get("timestamp"))
        ingested_ms = _ts_to_ms(message.get("ingested_at"))
        fw = message.get("firmware_version")
        reasons = []

        # 1. missing_field：关键字段为 None
        for fld in ("pitch_deg", "torque_nm", "battery_percent"):
            if tele.get(fld) is None:
                reasons.append("missing_field:%s" % fld)

        # 2. non_numeric：标量字段为非数值（acceleration/angular_velocity 等数组
        #    字段合法地为 [float, ...]，跳过；仅标量非数值才算异常）
        for fld, val in tele.items():
            if val is None:
                continue
            if isinstance(val, (list, tuple)):
                continue  # 数组字段，元素由解码层保证数值
            if not isinstance(val, (int, float)):
                reasons.append("non_numeric:%s" % fld)

        # 3. out_of_range：pitch > 180, torque > 100
        pitch = tele.get("pitch_deg")
        if pitch is not None and isinstance(pitch, (int, float)) and abs(pitch) > 180:
            reasons.append("out_of_range:pitch_deg")
        torque = tele.get("torque_nm")
        if torque is not None and isinstance(torque, (int, float)) and abs(torque) > 100:
            reasons.append("out_of_range:torque_nm")

        # 4. sequence checks（duplicate / gap / reconnect_duplicate）
        if seq is not None and st["last_seq"] is not None:
            if seq == st["last_seq"]:
                reasons.append("duplicate_sequence")
            elif seq > st["last_seq"] and (seq - st["last_seq"]) > 10:
                reasons.append("sequence_gap:%d->%d" % (st["last_seq"], seq))
        if seq is not None and seq in st["recent_seqs"]:
            reasons.append("reconnect_duplicate:%d" % seq)

        # 5. clock drift（设备时间 ts_ms 与入库时间 ingested_ms 偏差 > 200ms）
        #    独立于历史：首条即可检测（设备时钟与平台时钟的偏差与是否有前序帧无关）
        if ts_ms is not None and ingested_ms is not None and abs(ingested_ms - ts_ms) > 200:
            reasons.append("clock_drift")

        # 6. timestamp regress / sample rate anomaly（依赖历史状态）
        if ts_ms is not None and st["last_ts_ms"] is not None:
            if ts_ms < st["last_ts_ms"]:
                reasons.append("timestamp_regress")
            interval = ts_ms - st["last_ts_ms"]
            if (st["last_interval_ms"] is not None and st["last_interval_ms"] > 0
                    and interval > 0):
                expected = st["last_interval_ms"]
                if abs(interval - expected) > expected * 0.5:
                    reasons.append("sample_rate_anomaly")
            st["last_interval_ms"] = interval

        # 7. firmware_changed
        if (st["firmware_version"] is not None and fw is not None
                and fw != st["firmware_version"]):
            reasons.append("firmware_changed:%s->%s" % (st["firmware_version"], fw))

        # ---- 状态更新（在检查后，避免污染本次判断） ----
        if seq is not None:
            st["recent_seqs"].append(seq)
            st["last_seq"] = seq
        if ts_ms is not None:
            st["last_ts_ms"] = ts_ms
        if fw is not None:
            st["firmware_version"] = fw

        # ---- status 取最严重 ----
        if any(any(p in r for p in _INVALID_PREFIXES) for r in reasons):
            status = QUALITY_INVALID
        elif reasons:
            status = QUALITY_DEGRADED
        else:
            status = QUALITY_GOOD

        quality = message.get("quality") or {}
        quality["status"] = status
        quality["reasons"] = reasons
        message["quality"] = quality
        return message

    def reset(self, device_id=None):
        """重置状态（device_id=None 清所有）。"""
        if device_id is None:
            self._state.clear()
        else:
            self._state.pop(device_id, None)
