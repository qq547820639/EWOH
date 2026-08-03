"""MES/工单适配器：接收工单事件，输出统一语义工单消息。

对应 spec「多传感器适配扩展」：MES 数据同样适用来源标识与隔离；
厂商字段经 protocol.parse_work_order 转换为统一消息，不泄漏到上层。

read_message 返回归一化工单事件：
{task_id, task_name, station_id, required_skill, load_level, status,
 assigned_person_id, ts, source_type}
"""

import queue
import threading

from edge_platform.edge.adapters.base import BaseAdapter
from edge_platform.edge.adapters.mes.protocol import parse_work_order
from edge_platform.spatial import now_iso


class MESAdapter(BaseAdapter):
    """MES/工单适配器基类。

    真实驱动子类通过 _enqueue_raw(raw) 投递厂商工单事件，由 parse_work_order
    转换后入队；read_message 从队列取出统一语义工单消息。
    """

    DEVICE_TYPE = "mes"

    def __init__(self, device_id, source_type="real", system_name="MES-GENERIC", protocol_version="1.0"):
        super().__init__(device_id, source_type=source_type, model=system_name, firmware_version=protocol_version)
        self._inbox = queue.Queue(maxsize=512)
        self._last_msg = None
        self._last_seen = None

    def start(self):
        self._running = True
        self._started_at = now_iso()

    def stop(self):
        self._running = False

    def health(self):
        return {
            "device_id": self.device_id,
            "type": self.DEVICE_TYPE,
            "status": "online" if self._running else "offline",
            "source_type": self.source_type,
            "last_seen": self._last_seen,
            "started_at": self._started_at,
        }

    def device_info(self):
        return {
            "device_id": self.device_id,
            "type": self.DEVICE_TYPE,
            "model": self.model,
            "protocol_version": self.firmware_version,
            "source_type": self.source_type,
        }

    def read_message(self, timeout=None):
        try:
            msg = self._inbox.get(timeout=timeout)
        except queue.Empty:
            return None
        self._last_msg = msg
        self._last_seen = msg.get("ts") if isinstance(msg, dict) else None
        return msg

    def reconnect(self):
        self._running = True
        return True

    def _enqueue_raw(self, raw):
        """将厂商工单事件解析后入队（供真实驱动回调）。"""
        try:
            msg = parse_work_order(raw, default_source_type=self.source_type)
            self._inbox.put_nowait(msg)
        except queue.Full:
            pass


class SimulatedMESAdapter(MESAdapter):
    """模拟 MES 适配器：依序发射一小组工单事件。

    source_type='simulated'，仅用于工程自测/演示，不得作为真机验收依据。
    一轮任务发射完毕后若未停止则循环继续，供长期演示。
    """

    DEFAULT_TASKS = [
        {
            "task_id": "WO-001",
            "task_name": "月台卸货",
            "station_id": "STN-DOCK-A",
            "required_skill": "搬运",
            "load_level": 0.7,
            "status": "assigned",
            "assigned_person_id": "P-001",
        },
        {
            "task_id": "WO-002",
            "task_name": "产线供料",
            "station_id": "STN-LINE-1",
            "required_skill": "搬运",
            "load_level": 0.5,
            "status": "assigned",
            "assigned_person_id": "P-002",
        },
        {
            "task_id": "WO-003",
            "task_name": "末端装配",
            "station_id": "STN-ASSY-1",
            "required_skill": "装配",
            "load_level": 0.4,
            "status": "started",
            "assigned_person_id": "P-003",
        },
    ]

    def __init__(self, device_id="MES-SIM", tasks=None, hz=0.5, source_type="simulated"):
        super().__init__(device_id, source_type=source_type, system_name="MES-SIM")
        self.tasks = list(tasks or self.DEFAULT_TASKS)
        self.hz = float(hz)
        self._thread = None
        self._stop_evt = threading.Event()

    def start(self):
        super().start()
        self._stop_evt.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop_evt.set()
        if self._thread:
            self._thread.join(timeout=2.0)
        self._thread = None
        super().stop()

    def _run(self):
        period = 1.0 / self.hz if self.hz > 0 else 1.0
        while not self._stop_evt.is_set():
            for t in self.tasks:
                if self._stop_evt.is_set():
                    break
                msg = dict(t)
                msg["ts"] = now_iso()
                msg["source_type"] = self.source_type
                try:
                    self._inbox.put_nowait(msg)
                except queue.Full:
                    pass
                self._stop_evt.wait(period)

    def reconnect(self):
        if not self._running:
            self.start()
        return True
