"""进程内消息总线（pub/sub + 环形缓冲），Task 9。

对应 spec「流处理层（Redis Streams 或 NATS 实时事件 + PostgreSQL 业务数据 +
时序数据库高频遥测 + 对象存储 + WebSocket 前端推送）」之 in-process 参考实现：
本仓库坚持纯 Python 标准库与离线运行，故以 threading.Lock + 环形缓冲实现同一接口契约，
便于无外部基础设施时本地测试与受控试点。生产部署可在同一接口下替换为 Redis Streams
或 NATS，上层调用方无感知。

四条命名流（spec「总体架构」流处理层）：
- telemetry 高频遥测（外骨骼 IMU / UWB 位置 / 环境读数 等）
- state     设备与人员状态
- events    业务事件（风险事件 / 传感器冲突 / 调度建议 / 结果回流）
- assets    视频和三维资产索引

线程安全：所有读写经同一 self._lock 串行化（简单正确，足够本地/试点规模）。
"""

import threading
import uuid
from collections import deque
from typing import Callable

from edge_platform.spatial import now_iso

STREAMS: tuple[str, ...] = ("telemetry", "state", "events", "assets")


class MessageBus:
    """进程内 pub/sub 消息总线。

    - publish(stream, message)：追加到流环形缓冲（cap 控制），同步通知订阅者。
    - subscribe(stream, handler)：注册回调，返回 sub_id 用于取消。
    - tail(stream, n) / range(stream, start_ts, end_ts)：读取最近/区间消息。

    本类为 in-process 参考实现；生产环境可在同一接口下替换为 Redis Streams 或 NATS。
    """

    def __init__(self, cap=10000, streams=STREAMS):
        if cap <= 0:
            raise ValueError("cap 必须为正整数")
        self.cap = int(cap)
        self._streams = tuple(streams)
        self._buffers: dict[str, deque] = {s: deque(maxlen=self.cap) for s in self._streams}
        self._subs: dict[str, dict[str, Callable]] = {s: {} for s in self._streams}
        self._lock = threading.Lock()

    @property
    def streams(self):
        return self._streams

    def _check_stream(self, stream):
        if stream not in self._buffers:
            raise ValueError(f"未知流: {stream}（可用流: {', '.join(self._streams)}）")

    @staticmethod
    def _ensure_ts(message):
        """确保消息带 ts（用于 tail/range 排序与过滤）；缺失则补 now_iso()。"""
        if isinstance(message, dict) and not message.get("ts"):
            return dict(message, ts=now_iso())
        return message

    def publish(self, stream, message):
        """向指定流发布一条消息：入环形缓冲并同步通知订阅者。"""
        self._check_stream(stream)
        msg = self._ensure_ts(message)
        with self._lock:
            self._buffers[stream].append(msg)
            subs = list(self._subs[stream].values())
        # 在锁外回调，避免回调内再次 publish 造成死锁；订阅者异常不影响总线
        for handler in subs:
            try:
                handler(msg)
            except Exception:
                pass

    def subscribe(self, stream, handler):
        """订阅指定流；返回 sub_id，可用 unsubscribe 取消。"""
        self._check_stream(stream)
        if not callable(handler):
            raise TypeError("handler 必须可调用")
        sub_id = f"{stream}-{uuid.uuid4().hex[:12]}"
        with self._lock:
            self._subs[stream][sub_id] = handler
        return sub_id

    def unsubscribe(self, stream, sub_id):
        """取消订阅；返回是否成功取消。"""
        self._check_stream(stream)
        with self._lock:
            return self._subs[stream].pop(sub_id, None) is not None

    def tail(self, stream, n):
        """返回流中最近 n 条消息（按写入顺序，不足则全返）。"""
        self._check_stream(stream)
        n = int(n) if n is not None else 0
        if n <= 0:
            return []
        with self._lock:
            buf = list(self._buffers[stream])
        return buf[-n:] if n < len(buf) else buf

    def range(self, stream, start_ts, end_ts):
        """返回流中 ts ∈ [start_ts, end_ts] 的消息（按写入顺序）。

        start_ts/end_ts 接受 ISO 8601 字符串或 Unix 毫秒；ISO 8601 UTC 毫秒精度
        字符串可按字典序比较，数值按数值比较；类型不一致时统一降级为字符串比较。
        """
        self._check_stream(stream)
        with self._lock:
            buf = list(self._buffers[stream])
        out = []
        for m in buf:
            ts = m.get("ts") if isinstance(m, dict) else None
            if ts is None:
                continue
            if _in_range(ts, start_ts, end_ts):
                out.append(m)
        return out

    def length(self, stream):
        """返回流当前缓冲长度（调试/测试用）。"""
        self._check_stream(stream)
        with self._lock:
            return len(self._buffers[stream])


def _in_range(ts, start_ts, end_ts):
    """判断 ts 是否落在 [start_ts, end_ts]。

    ISO 8601 UTC 毫秒精度字符串可按字典序比较；数值按数值比较；混同类型时
    统一转字符串比较（保守策略，调用方应保证一致类型）。
    """

    def _key(v):
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return ("n", float(v))
        return ("s", str(v))

    k = _key(ts)
    ks = _key(start_ts)
    ke = _key(end_ts)
    if k[0] != ks[0] or k[0] != ke[0]:
        # 类型不一致：统一降级为字符串比较
        return str(start_ts) <= str(ts) <= str(end_ts)
    if k[0] == "n":
        return ks[1] <= k[1] <= ke[1]
    return ks[1] <= k[1] <= ke[1]
