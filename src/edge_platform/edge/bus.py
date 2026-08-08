"""进程内消息总线（pub/sub + 环形缓冲），Task 9。

统一契约（P0-EDGE-003）——全仓唯一正式契约，所有调用方（Inference / Event
Engine / Scheduler / World Model / Test）必须一致使用：

- ``publish(stream, message)``：向流追加消息并同步通知订阅者；
- ``subscribe(stream, handler)``：注册回调，返回 subscription_id（str）；
- ``unsubscribe(stream, subscription_id)``：取消订阅；
- ``tail(stream, n)`` / ``range(stream, start_ts, end_ts)``：读取最近/区间消息。

禁止任何调用方假设 queue 语义（如 ``subscribe(topic) -> queue``）。

流（Stream）名称统一引用 ``edge_platform.runtime.protocols`` 的 ``STREAM_*``
常量（P0-EDGE-004），业务代码不得使用裸字符串 topic。生产新增流必须先登记到
``ALL_STREAMS``。

线程安全：所有读写经同一 self._lock 串行化（简单正确，足够本地/试点规模）。

Subscriber 异常（P0-EDGE-005）：handler 异常不会击穿总线，但必须记录日志与
计数器（``event_bus_handler_errors_total``），不得静默吞掉。
"""

from __future__ import annotations

import logging
import threading
import uuid
from collections import deque
from typing import Callable

from edge_platform.runtime.protocols import ALL_STREAMS
from edge_platform.spatial import now_iso

logger = logging.getLogger("ewoh.edge.bus")

STREAMS: tuple[str, ...] = ALL_STREAMS


class MessageBus:
    """进程内 pub/sub 消息总线（唯一正式契约实现）。

    - publish(stream, message)：追加到流环形缓冲（cap 控制），同步通知订阅者；
    - subscribe(stream, handler)：注册回调，返回 sub_id 用于取消；
    - tail(stream, n) / range(stream, start_ts, end_ts)：读取最近/区间消息。

    本类为 in-process 实现；生产环境可在同一接口下替换为 Redis Streams 或 NATS。
    """

    def __init__(self, cap=10000, streams=STREAMS, metrics_collector=None):
        if cap <= 0:
            raise ValueError("cap 必须为正整数")
        self.cap = int(cap)
        self._streams = tuple(streams)
        self._buffers: dict[str, deque] = {s: deque(maxlen=self.cap) for s in self._streams}
        self._subs: dict[str, dict[str, Callable]] = {s: {} for s in self._streams}
        self._lock = threading.Lock()
        # P0-EDGE-005：handler 异常观测（计数器 + 可选注入 MetricsCollector）
        self._metrics = metrics_collector
        self._handler_errors_total = 0

    @property
    def streams(self):
        return self._streams

    @property
    def handler_errors_total(self) -> int:
        """事件总线 handler 异常累计计数（event_bus_handler_errors_total）。"""
        with self._lock:
            return self._handler_errors_total

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
        """向指定流发布一条消息：入环形缓冲并同步通知订阅者。

        handler 异常：记录日志（stream / subscription_id / handler / message 摘要 /
        exception / traceback）并累计 counter，不影响其他订阅者与总线本身。
        """
        self._check_stream(stream)
        msg = self._ensure_ts(message)
        with self._lock:
            self._buffers[stream].append(msg)
            subs = list(self._subs[stream].items())
        # 在锁外回调，避免回调内再次 publish 造成死锁；订阅者异常不影响总线
        for sub_id, handler in subs:
            try:
                handler(msg)
            except Exception:
                self._record_handler_error(stream, sub_id, handler, msg)

    def _record_handler_error(self, stream, sub_id, handler, msg):
        with self._lock:
            self._handler_errors_total += 1
        event_id = None
        if isinstance(msg, dict):
            event_id = msg.get("event_id") or msg.get("record_id") or msg.get("inference_id")
        handler_name = getattr(handler, "__name__", repr(handler))
        logger.exception(
            "event_bus_handler_error stream=%s subscription_id=%s handler=%s event_id=%s message_keys=%s",
            stream,
            sub_id,
            handler_name,
            event_id,
            sorted(msg.keys()) if isinstance(msg, dict) else type(msg).__name__,
        )
        if self._metrics is not None:
            try:
                self._metrics.record_bus_handler_error(stream, handler_name)
            except Exception:
                pass

    def subscribe(self, stream, handler):
        """订阅指定流；返回 sub_id，可用 unsubscribe 取消。

        正式契约（P0-EDGE-003）：handler 为 ``Callable[[dict], None]``。
        """
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
        """返回流中 ts ∈ [start_ts, end_ts] 的消息（按写入顺序）。"""
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
    """判断 ts 是否落在 [start_ts, end_ts]。"""

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
