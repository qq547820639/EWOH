"""实时事件总线：线程安全的进程内广播，支撑 SSE 实时同步（Phase 5）。

事件类型（与 .trae/specs/cmd-map-edge-scheduling/tasks.md 对齐）：
- resource.updated / telemetry.updated：资源状态 / 遥测更新
- task.created / task.updated：任务创建 / 更新
- assignment.updated：派工状态变化
- schedule.proposed / schedule.confirmed / schedule.expired / schedule.conflict：
  方案生成 / 确认 / 过期 / 冲突
- event.opened / event.closed：风险事件开 / 闭

每个事件携带 event_id / event_type / entity_id / version / source_ts / server_ts / payload。
订阅者可按 event_type 过滤；慢消费者积压超限时丢弃最旧事件（不阻塞发布者）。

纯 Python 标准库实现（threading + queue），不引入第三方依赖。
"""

import queue
import threading

from edge_platform.spatial import new_id, now_iso


class EventBus:
    """进程内事件总线：subscribe 返回队列，publish 广播给匹配订阅者。"""

    def __init__(self, max_backlog=1000):
        self._lock = threading.Lock()
        self._subscribers = []  # list of (event_type, queue)
        self._max_backlog = max_backlog

    def subscribe(self, event_type=None):
        """订阅事件；event_type 为 None 表示订阅全部事件。返回一个队列。"""
        q = queue.Queue(maxsize=self._max_backlog)
        with self._lock:
            self._subscribers.append((event_type, q))
        return q

    def unsubscribe(self, subscription):
        """取消订阅。subscription 为 subscribe 返回的队列。"""
        with self._lock:
            self._subscribers = [
                (t, q) for (t, q) in self._subscribers if q is not subscription
            ]

    def publish(self, event_type, entity_id="", version=1, source_ts="", payload=None):
        """发布事件并广播给匹配订阅者；慢消费者丢弃最旧事件（不阻塞发布者）。"""
        event = {
            "event_id": new_id("EV"),
            "event_type": event_type,
            "entity_id": entity_id,
            "version": int(version or 1),
            "source_ts": source_ts or now_iso(),
            "server_ts": now_iso(),
            "payload": payload or {},
        }
        with self._lock:
            subs = list(self._subscribers)
        for evt_type, q in subs:
            if evt_type is not None and evt_type != event_type:
                continue
            try:
                q.put_nowait(event)
            except queue.Full:
                # 丢弃积压：慢消费者落后时丢弃最旧事件，避免阻塞发布者
                try:
                    q.get_nowait()
                    q.put_nowait(event)
                except (queue.Empty, queue.Full):
                    pass
        return event
