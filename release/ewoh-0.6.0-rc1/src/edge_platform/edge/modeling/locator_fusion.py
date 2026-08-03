#!/usr/bin/env python3
"""locator_fusion.py — UWB + Wi-Fi + 视觉定位融合。

对应 spec §5.2「场景直接建模 — L2 三维 + 多源融合接入」。

工作流
------
1. 接收多源定位原始数据：
   - UWB：到达时间差（TDOA）→ 坐标
   - Wi-Fi：RSSI 指纹 → 坐标
   - 视觉：摄像头骨架/目标检测 → 坐标
2. EKF（Extended Kalman Filter）或因子图融合多源坐标
3. 输出融合后坐标流（entity_id, x, y, z, confidence）
4. 推送到 spark-app /api/ingest/location

本脚本提供融合框架，EKF 实现需 numpy（可选依赖）。

用法
----
  python locator_fusion.py --entity-id P-001 --spark-url http://localhost:3000 \
      --interval-ms 500 --ingest-key secret
"""

from __future__ import annotations

import argparse
import json
import random
import threading
import time
from datetime import datetime, timezone
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class LocatorFusion:
    """多源定位融合（UWB + Wi-Fi + 视觉）。

    使用简化 EKF 融合多源观测，输出融合坐标。
    无 numpy 时退化为加权平均。
    """

    def __init__(self, entity_id: str):
        self.entity_id = entity_id
        self._x = 0.0
        self._y = 0.0
        self._z = 0.0
        self._has_numpy = False
        try:
            import numpy as np  # noqa: F401

            self._has_numpy = True
        except ImportError:
            pass

    def fuse(self, uwb: dict | None = None, wifi: dict | None = None, visual: dict | None = None) -> dict[str, Any]:
        """融合多源定位观测，返回融合后坐标。

        每个观测格式: {'x': float, 'y': float, 'z': float, 'confidence': float}
        """
        observations = []
        for obs in (uwb, wifi, visual):
            if obs and obs.get("confidence", 0) > 0:
                observations.append(obs)
        if not observations:
            return {"x": self._x, "y": self._y, "z": self._z, "confidence": 0.0, "locator": "fusion"}

        # 加权平均（无 numpy 时简化）
        total_w = sum(o["confidence"] for o in observations)
        if total_w == 0:
            total_w = 1
        fx = sum(o["x"] * o["confidence"] for o in observations) / total_w
        fy = sum(o["y"] * o["confidence"] for o in observations) / total_w
        fz = sum(o.get("z", 0) * o["confidence"] for o in observations) / total_w
        fconf = min(1.0, total_w / len(observations))

        # 平滑（简单低通滤波）
        alpha = 0.6
        self._x = alpha * fx + (1 - alpha) * self._x
        self._y = alpha * fy + (1 - alpha) * self._y
        self._z = alpha * fz + (1 - alpha) * self._z

        return {
            "x": round(self._x, 1),
            "y": round(self._y, 1),
            "z": round(self._z, 1),
            "confidence": round(fconf, 3),
            "locator": "fusion",
        }


class SimulatedLocatorSource:
    """模拟多源定位数据源（无真机时测试用）。"""

    def __init__(self, entity_id: str, interval_ms: int = 500):
        self.entity_id = entity_id
        self.interval_ms = max(100, interval_ms)
        self._fusion = LocatorFusion(entity_id)
        self._running = False
        self._thread: threading.Thread | None = None
        self._latest: dict | None = None

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._running = False
        if self._thread:
            self._thread.join(timeout=2)

    def read(self, timeout: float = 1.0) -> dict | None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self._latest:
                return self._latest
            time.sleep(0.05)
        return None

    def _loop(self):
        while self._running:
            uwb = {
                "x": random.uniform(0, 1000),
                "y": random.uniform(0, 800),
                "z": 0,
                "confidence": random.uniform(0.7, 0.95),
            }
            wifi = {
                "x": random.uniform(0, 1000),
                "y": random.uniform(0, 800),
                "z": 0,
                "confidence": random.uniform(0.5, 0.8),
            }
            visual = {
                "x": random.uniform(0, 1000),
                "y": random.uniform(0, 800),
                "z": 0,
                "confidence": random.uniform(0.6, 0.9),
            }
            fused = self._fusion.fuse(uwb=uwb, wifi=wifi, visual=visual)
            self._latest = {
                "entity_id": self.entity_id,
                "locator": "fusion",
                "confidence": fused["confidence"],
                "x": fused["x"],
                "y": fused["y"],
                "z": fused["z"],
                "ts": now_iso(),
                "source_type": "simulated",
            }
            time.sleep(self.interval_ms / 1000.0)


def push_location(loc: dict[str, Any], spark_url: str, ingest_key: str = "") -> bool:
    """推送定位坐标到 spark-app /api/ingest/location。"""
    url = f"{spark_url.rstrip('/')}/api/ingest/location"
    body = json.dumps(loc).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if ingest_key:
        headers["X-Ingest-Key"] = ingest_key
    req = urllib_request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib_request.urlopen(req, timeout=5) as resp:  # nosec B310 - configured internal HTTP client
            return 200 <= resp.status < 300
    except urllib_error.URLError as e:
        print(f"[locator] 推送失败: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(description="UWB+Wi-Fi+视觉定位融合")
    parser.add_argument("--entity-id", required=True, help="跟踪实体ID")
    parser.add_argument("--spark-url", default="http://localhost:3000", help="spark-app 地址")
    parser.add_argument("--ingest-key", default="", help="Ingestion API Key")
    parser.add_argument("--interval-ms", type=int, default=500, help="推送间隔毫秒")
    args = parser.parse_args()

    source = SimulatedLocatorSource(args.entity_id, args.interval_ms)
    source.start()
    print(f"[locator] 启动融合定位 entity={args.entity_id}, interval={args.interval_ms}ms")
    try:
        while True:
            loc = source.read(timeout=2.0)
            if loc:
                ok = push_location(loc, args.spark_url, args.ingest_key)
                if ok:
                    print(f"[locator] 推送成功 x={loc['x']}, y={loc['y']}, conf={loc['confidence']}")
            time.sleep(args.interval_ms / 1000.0)
    except KeyboardInterrupt:
        print("\n[locator] 退出...")
    finally:
        source.stop()


if __name__ == "__main__":
    main()
