"""EWOH 进程内发布/订阅总线（线程安全，纯标准库）。

对齐 edge_platform/stubs.py 的 Bus 签名：
- subscribe(topic) -> Queue
- publish(topic, msg)

供适配层（telemetry/device_status）与推理管线（telemetry/inference/event）解耦。
"""
import queue
import threading

_DEFAULT_MAXSIZE = 1000


class Bus:
    """线程安全 pub/sub 总线（每 topic 多订阅者，满队列丢弃最新以不阻塞发布者）。"""

    def __init__(self):
        self._subs = {}
        self._lock = threading.Lock()

    def subscribe(self, topic):
        q = queue.Queue(maxsize=_DEFAULT_MAXSIZE)
        with self._lock:
            self._subs.setdefault(topic, []).append(q)
        return q

    def publish(self, topic, msg):
        with self._lock:
            subs = list(self._subs.get(topic, []))
        for q in subs:
            try:
                q.put_nowait(msg)
            except queue.Full:
                pass  # 订阅者消费不过来时丢弃，不阻塞发布者
