"""环境传感器适配器：温度/振动/噪声/空气质量，输出统一语义环境读数。

对应 spec「多传感器适配扩展」：环境传感器数据统一语义化、来源标识与隔离；
厂商字段经 protocol.parse_env_reading 转换为统一消息，不泄漏到上层。

read_message 返回归一化环境读数：
{sensor_id, station_id, temperature_c, vibration_mm_s, noise_db,
 air_quality_pm25, ts, source_type, quality_status}
"""

import queue
import random
import threading
from dataclasses import dataclass

from edge_platform.edge.adapters.base import BaseAdapter
from edge_platform.edge.adapters.environment.protocol import parse_env_reading
from edge_platform.spatial import now_iso


@dataclass
class EnvSensorAsset:
    """环境传感器资产台账项。"""

    sensor_id: str
    station_id: str
    source_type: str = "real"


class EnvSensorAdapter(BaseAdapter):
    """环境传感器适配器基类。

    真实驱动子类通过 _enqueue_raw(raw) 投递厂商读数，由 parse_env_reading
    转换后入队；read_message 从队列取出统一语义环境读数。
    """

    DEVICE_TYPE = "env_sensor"

    def __init__(self, asset, source_type=None):
        if isinstance(asset, str):
            asset = EnvSensorAsset(sensor_id=asset, station_id="", source_type=source_type or "real")
        else:
            if source_type is not None:
                asset.source_type = source_type
        super().__init__(asset.sensor_id, source_type=asset.source_type, model="ENV-GENERIC")
        self.asset = asset
        self._inbox = queue.Queue(maxsize=1024)
        self._last_msg = None
        self._last_seen = None

    def start(self):
        self._running = True
        self._started_at = now_iso()

    def stop(self):
        self._running = False

    def health(self):
        return {
            "device_id": self.asset.sensor_id,
            "type": self.DEVICE_TYPE,
            "status": "online" if self._running else "offline",
            "source_type": self.source_type,
            "last_seen": self._last_seen,
            "started_at": self._started_at,
        }

    def device_info(self):
        return {
            "device_id": self.asset.sensor_id,
            "type": self.DEVICE_TYPE,
            "model": self.model,
            "source_type": self.source_type,
            "station_id": self.asset.station_id,
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
        """将厂商环境读数解析后入队（供真实驱动回调）。"""
        try:
            msg = parse_env_reading(
                raw,
                default_sensor_id=self.asset.sensor_id,
                default_station_id=self.asset.station_id,
                default_source_type=self.source_type,
            )
            self._inbox.put_nowait(msg)
        except queue.Full:
            pass


class SimulatedEnvSensorAdapter(EnvSensorAdapter):
    """模拟环境传感器适配器：周期性发射环境读数。

    source_type='simulated'，仅用于工程自测/演示，不得作为真机验收依据。
    """

    def __init__(self, sensor_id, station_id, hz=1.0, source_type="simulated"):
        asset = EnvSensorAsset(sensor_id=sensor_id, station_id=station_id, source_type=source_type)
        super().__init__(asset, source_type=source_type)
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
            msg = {
                "sensor_id": self.asset.sensor_id,
                "station_id": self.asset.station_id,
                "temperature_c": round(random.uniform(18.0, 32.0), 2),
                "vibration_mm_s": round(random.uniform(0.2, 4.5), 3),
                "noise_db": round(random.uniform(55.0, 88.0), 1),
                "air_quality_pm25": round(random.uniform(10.0, 75.0), 1),
                "ts": now_iso(),
                "source_type": self.source_type,
                "quality_status": "good",
            }
            try:
                self._inbox.put_nowait(msg)
            except queue.Full:
                pass
            self._stop_evt.wait(period)

    def reconnect(self):
        if not self._running:
            self.start()
        return True
