"""UWB 定位适配器：读取 UWB 标签位置帧，输出统一语义位置消息。

对应 spec「多传感器适配扩展」：原始厂商字段经 protocol.parse_uwb_frame 转换为
统一消息，厂商字段不泄漏到上层业务；source_type=real/controlled_test/simulated 隔离。

read_message 返回归一化位置消息：
{tag_id, person_id, x, y, z, quality_status, confidence, ts, source_type, beacon_ids}
"""

import queue
import threading
from dataclasses import dataclass
from typing import List, Optional, Tuple

from edge_platform.spatial import now_iso
from edge_platform.edge.adapters.base import BaseAdapter
from edge_platform.edge.adapters.uwb.protocol import parse_uwb_frame


@dataclass
class UWBBeacon:
    """UWB 基站（锚点）：beacon_id + 工厂坐标系位置。"""
    beacon_id: str
    x: float
    y: float
    z: float = 0.0
    source_type: str = "real"


@dataclass
class UWBTag:
    """UWB 标签：绑定人员。"""
    tag_id: str
    person_id: Optional[str] = None


class UWBAdapter(BaseAdapter):
    """UWB 定位适配器基类。

    真实驱动子类通过 _enqueue_raw(raw) 投递厂商原始帧，由 parse_uwb_frame 转换后入队；
    read_message 从队列取出统一语义消息。
    """

    DEVICE_TYPE = "uwb"

    def __init__(self, device_id, beacons, tags, source_type="real",
                 model="UWB-GENERIC", firmware_version=""):
        super().__init__(device_id, source_type=source_type, model=model,
                         firmware_version=firmware_version)
        self.beacons = list(beacons)
        self.tags = {t.tag_id: t for t in tags}
        self._inbox = queue.Queue(maxsize=1024)
        self._last_msg = None
        self._last_seen = None

    def start(self):
        self._running = True
        self._started_at = now_iso()

    def stop(self):
        self._running = False

    def health(self):
        status = "online" if self._running else "offline"
        return {
            "device_id": self.device_id,
            "type": self.DEVICE_TYPE,
            "status": status,
            "source_type": self.source_type,
            "last_seen": self._last_seen,
            "started_at": self._started_at,
        }

    def device_info(self):
        return {
            "device_id": self.device_id,
            "type": self.DEVICE_TYPE,
            "model": self.model,
            "firmware_version": self.firmware_version,
            "source_type": self.source_type,
            "beacon_count": len(self.beacons),
            "tag_count": len(self.tags),
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
        """将厂商原始帧解析后入队（供真实驱动回调）。"""
        try:
            msg = parse_uwb_frame(raw, beacons=self.beacons, tags=self.tags,
                                  default_source_type=self.source_type)
            self._inbox.put_nowait(msg)
        except queue.Full:
            # 背压：直接丢新帧，避免阻塞驱动线程；生产实现可接入丢包计数
            pass


class SimulatedUWBAdapter(UWBAdapter):
    """模拟 UWB 适配器：按给定路径以固定 Hz 生成移动标签位置消息。

    source_type='simulated'，仅用于工程自测/演示，不得作为真机验收依据（spec「来源隔离」）。
    """

    def __init__(self, device_id, tag_id, person_id, path,
                 beacons=None, hz=2.0, source_type="simulated"):
        beacons = list(beacons) if beacons else []
        tags = [UWBTag(tag_id=tag_id, person_id=person_id)]
        super().__init__(device_id, beacons=beacons, tags=tags, source_type=source_type,
                         model="UWB-SIM")
        self.tag_id = tag_id
        self.person_id = person_id
        self.path = list(path)
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
        idx = 0
        n = len(self.path)
        while not self._stop_evt.is_set() and n > 0:
            waypoint = self.path[idx % n]
            x, y = waypoint[0], waypoint[1]
            z = waypoint[2] if len(waypoint) > 2 else 0.0
            msg = {
                "tag_id": self.tag_id,
                "person_id": self.person_id,
                "x": float(x),
                "y": float(y),
                "z": float(z),
                "quality_status": "good",
                "confidence": 0.95,
                "ts": now_iso(),
                "source_type": self.source_type,
                "beacon_ids": [b.beacon_id for b in self.beacons],
            }
            try:
                self._inbox.put_nowait(msg)
            except queue.Full:
                pass
            idx += 1
            self._stop_evt.wait(period)

    def reconnect(self):
        if not self._running:
            self.start()
        return True
