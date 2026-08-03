"""摄像头视觉适配器：边缘侧完成人体检测与骨架提取，输出统一语义检测帧。

对应 spec「摄像头接入与边缘视觉」：中心平台保存结构化结果（骨架/检测框）而非
原始视频；每个识别结果附带置信度、摄像头 ID、模型版本；source_type 区分
real/controlled_test/simulated。

read_message 返回归一化检测/骨架帧：
{camera_id, persons: [{track_id, skeleton_json, bbox_xyxy, confidence}],
 ts, source_type, model_version}
"""

import queue
import threading
from dataclasses import dataclass
from typing import Optional

from edge_platform.edge.adapters.base import BaseAdapter
from edge_platform.edge.adapters.camera.protocol import parse_detection
from edge_platform.spatial import now_iso


@dataclass
class CameraAsset:
    """摄像头资产台账项：camera_id + 工厂坐标系位姿 + 内参/帧率。"""

    camera_id: str
    location_pose: Optional[dict] = None  # {x, y, z, yaw_deg}
    fov_deg: float = 90.0
    resolution: tuple[int, int] = (1920, 1080)  # (width, height)
    fps: float = 25.0
    source_type: str = "real"


class CameraAdapter(BaseAdapter):
    """摄像头适配器基类。

    真实驱动子类通过 _enqueue_raw(raw) 投递厂商原始检测帧，由 parse_detection
    转换后入队；read_message 从队列取出统一语义检测/骨架帧。
    """

    DEVICE_TYPE = "camera"

    def __init__(self, asset, source_type=None, model_version="edge-pose-v0.1"):
        if isinstance(asset, str):
            asset = CameraAsset(camera_id=asset, source_type=source_type or "real")
        else:
            if source_type is not None:
                asset.source_type = source_type
        super().__init__(asset.camera_id, source_type=asset.source_type, model="CAM-GENERIC")
        self.asset = asset
        self.model_version = model_version
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
            "device_id": self.asset.camera_id,
            "type": self.DEVICE_TYPE,
            "status": "online" if self._running else "offline",
            "source_type": self.source_type,
            "last_seen": self._last_seen,
            "started_at": self._started_at,
            "model_version": self.model_version,
        }

    def device_info(self):
        return {
            "device_id": self.asset.camera_id,
            "type": self.DEVICE_TYPE,
            "model": self.model,
            "source_type": self.source_type,
            "fov_deg": self.asset.fov_deg,
            "resolution": list(self.asset.resolution),
            "fps": self.asset.fps,
            "model_version": self.model_version,
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
        """将厂商原始检测帧解析后入队（供真实驱动回调）。"""
        try:
            msg = parse_detection(
                raw,
                camera_id=self.asset.camera_id,
                default_source_type=self.source_type,
                default_model_version=self.model_version,
            )
            self._inbox.put_nowait(msg)
        except queue.Full:
            pass


class SimulatedCameraAdapter(CameraAdapter):
    """模拟摄像头适配器：周期性生成骨架检测帧。

    source_type='simulated'，仅用于工程自测/演示，不得作为真机验收依据。
    """

    def __init__(self, camera_id, hz=1.0, model_version="edge-pose-v0.1", source_type="simulated", track_ids=None):
        asset = CameraAsset(camera_id=camera_id, source_type=source_type)
        super().__init__(asset, source_type=source_type, model_version=model_version)
        self.hz = float(hz)
        self.track_ids = list(track_ids or ["P1", "P2"])
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
        step = 0
        while not self._stop_evt.is_set():
            persons = []
            for i, tid in enumerate(self.track_ids):
                persons.append(
                    {
                        "track_id": tid,
                        "skeleton_json": {
                            "version": 1,
                            "keypoints": [
                                [100 + step * 2 + i * 50, 200, 0.95],
                                [120 + step * 2 + i * 50, 180, 0.92],
                            ],
                        },
                        "bbox_xyxy": [80 + i * 50, 120, 180 + i * 50, 380],
                        "confidence": 0.88,
                    }
                )
            msg = {
                "camera_id": self.asset.camera_id,
                "persons": persons,
                "ts": now_iso(),
                "source_type": self.source_type,
                "model_version": self.model_version,
            }
            try:
                self._inbox.put_nowait(msg)
            except queue.Full:
                pass
            step += 1
            self._stop_evt.wait(period)

    def reconnect(self):
        if not self._running:
            self.start()
        return True
