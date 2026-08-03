#!/usr/bin/env python3
"""edge_to_spark.py — 边缘侧到 spark-app 的数据桥接脚本（皮肤+肢体数据上行）。

将 NyExoA1Adapter 产出的 UnifiedExoFrame（统一语义帧）序列化后 POST 到
spark-app 的 Ingestion 网关（/api/ingest/exoskeleton），实现真机数据直连。

特性
----
- 拉模式读取适配器帧（read_message → to_storage_dict）
- 断线重连（指数退避，最大 60s）
- 批量缓冲（断网时本地队列，恢复后批量补传，≤100 条/批）
- source_type 透传（real/controlled_test/simulated）
- 内置 SimulatedExoSource，无真机时可用 --source-type simulated 端到端测试

用法
----
  # 真机模式（需 NyExoA1Adapter + 设备字节流驱动）
  python edge_to_spark.py --spark-url http://localhost:3000 \
      --ingest-key secret --device-config devices/exo001.json --source-type real

  # 模拟模式（无真机，内置模拟源）
  python edge_to_spark.py --spark-url http://localhost:3000 \
      --source-type simulated --interval-ms 1000

依赖：仅 Python 3.8+ 标准库（urllib/json/time/hashlib/queue）
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import queue
import random
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

# 兼容 edge_platform 包导入（可选，真机模式需要）
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
if os.path.isdir(os.path.join(_REPO_ROOT, "src", "edge_platform")):
    sys.path.insert(0, os.path.join(_REPO_ROOT, "src"))


def _now_iso() -> str:
    """当前 UTC 时间 ISO 8601 字符串。"""
    return datetime.now(timezone.utc).isoformat()


# ===== 模拟外骨骼数据源（无真机时用于端到端测试） =====


class SimulatedExoSource:
    """内置模拟外骨骼数据源，产出 UnifiedExoFrame 格式的 storage dict。

    模拟 NY-EXO-A1 腰部助力外骨骼的典型遥测：姿态/负荷/电量/温度/关节角等。
    用于 --source-type simulated 模式下的端到端桥接测试。
    """

    def __init__(self, device_id: str = "EXO-SIM-001", worker_id: str = "P-SIM-001", interval_ms: int = 1000):
        self.device_id = device_id
        self.worker_id = worker_id
        self.interval_ms = max(100, interval_ms)
        self._running = False
        self._inbox: queue.Queue = queue.Queue(maxsize=1024)
        self._thread: threading.Thread | None = None
        # 模拟状态
        self._battery = 85.0
        self._load = 0.3
        self._pitch = 8.0
        self._cumulative = 0.0
        self._seq = 0

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

    def read(self, timeout: float = 1.0) -> dict[str, Any] | None:
        try:
            return self._inbox.get(timeout=timeout)
        except queue.Empty:
            return None

    def _loop(self):
        while self._running:
            try:
                frame = self._gen_frame()
                self._inbox.put(frame, timeout=1)
            except queue.Full:
                pass
            time.sleep(self.interval_ms / 1000.0)

    def _gen_frame(self) -> dict[str, Any]:
        self._seq += 1
        # 模拟状态游走
        self._load = max(0.1, min(0.9, self._load + random.uniform(-0.15, 0.15)))
        self._pitch = max(0, min(60, self._pitch + random.uniform(-5, 5)))
        self._battery = max(0, min(100, self._battery - random.uniform(0.2, 0.8)))
        if self._battery < 5:
            self._battery = 100  # 换电
        self._cumulative = max(self._load, min(1.0, self._cumulative + self._load * 0.01))

        event_time = _now_iso()
        raw_payload = f"{self.device_id}|{self._seq}|{event_time}"
        raw_ref = hashlib.sha256(raw_payload.encode()).hexdigest()

        return {
            "record_id": f"REC-{uuid4().hex[:12]}",
            "ingested_at": _now_iso(),
            "device_model": "NY-EXO-SIM",
            "firmware_version": "1.0.0-sim",
            "protocol_version": "NXP1-sim",
            "raw_ref": raw_ref,
            "device_id": self.device_id,
            "entity_id": self.device_id,
            "worker_id": self.worker_id,
            "event_time": event_time,
            "source_type": "simulated",
            "pose": {
                "trunk_pitch_deg": round(self._pitch, 2),
                "angular_velocity_dps": round(random.uniform(5, 20), 2),
                "joint_angles_deg": {
                    "left_knee": round(random.uniform(20, 60), 1),
                    "right_knee": round(random.uniform(20, 60), 1),
                    "hip": round(random.uniform(-10, 30), 1),
                },
            },
            "load": {
                "assist_level": round(self._load, 2),
                "torque_nm": round(self._load * 25, 2),
                "cumulative_load_score": round(self._cumulative, 3),
            },
            "device": {
                "battery_pct": round(self._battery),
                "temperature_c": round(random.uniform(34, 38), 1),
                "fault_code": None,
                "health": "good" if self._load < 0.8 else "warn",
            },
            "quality": {
                "packet_loss_pct": round(random.uniform(0, 1.5), 2),
                "confidence": round(random.uniform(0.85, 0.99), 3),
                "status": "good",
            },
            # 兼容旧版扁平字段
            "pitch_deg": round(self._pitch, 2),
            "load_score": round(self._cumulative, 3),
            "battery_pct": round(self._battery),
            "quality_status": "good",
        }


# ===== 真机适配器包装（可选，需要 edge_platform 包） =====


class RealExoSource:
    """真机外骨骼数据源，包装 NyExoA1Adapter。

    需要设备字节流驱动（TCP/串口），通过 feed(raw_bytes) 投递。
    本类提供 read_message 拉取统一语义帧。
    """

    def __init__(self, device_config: str):
        self.device_config = device_config
        self._adapter = None
        self._load_config()

    def _load_config(self):
        try:
            from edge_platform.edge.adapters.ny_exo_a1.adapter import NyExoA1Adapter
        except ImportError as err:
            raise RuntimeError(
                "无法导入 NyExoA1Adapter，请确保 edge_platform 包可用。模拟模式请用 --source-type simulated"
            ) from err
        cfg = {}
        if self.device_config and os.path.isfile(self.device_config):
            with open(self.device_config) as f:
                cfg = json.load(f)
        self._adapter = NyExoA1Adapter(
            device_id=cfg.get("device_id", "EXO-001"),
            source_type=cfg.get("source_type", "real"),
            model=cfg.get("model", "NY-EXO-A1"),
            firmware_version=cfg.get("firmware_version", ""),
            worker_id=cfg.get("worker_id"),
        )

    def read(self, timeout: float = 1.0) -> dict[str, Any] | None:
        if self._adapter is None:
            return None
        return self._adapter.read_message(timeout=timeout)


# ===== HTTP 桥接客户端 =====


class SparkBridge:
    """桥接客户端：从数据源读取帧，POST 到 spark-app Ingestion 网关。

    特性：
    - 断线重连（指数退避，最大 60s）
    - 批量缓冲（断网时本地队列，恢复后批量补传，≤100 条/批）
    """

    BATCH_SIZE = 100
    MAX_BACKOFF_SEC = 60

    def __init__(
        self,
        spark_url: str,
        ingest_key: str = "",
        source: Any = None,
        org_id: str = "",
    ):
        self.spark_url = spark_url.rstrip("/")
        self.ingest_key = ingest_key
        self.org_id = org_id
        self.source = source
        self._buffer: list = []
        self._running = False
        self._consecutive_failures = 0

    def run(self):
        """主循环：持续读取帧并尝试发送。"""
        self._running = True
        if hasattr(self.source, "start"):
            self.source.start()
        print(f"[bridge] 启动，目标: {self.spark_url}/api/ingest/exoskeleton")
        try:
            while self._running:
                frame = self.source.read(timeout=1.0)
                if frame is None:
                    # 无帧时尝试清空缓冲
                    if self._buffer:
                        self._flush_batch()
                    continue
                self._buffer.append(frame)
                # 达到批量上限或单帧模式直接发送
                if len(self._buffer) >= 1:
                    self._flush_batch()
        except KeyboardInterrupt:
            print("\n[bridge] 收到中断信号，退出...")
        finally:
            self._running = False
            if hasattr(self.source, "stop"):
                self.source.stop()
            # 最后尝试清空缓冲
            if self._buffer:
                self._flush_batch()

    def _flush_batch(self):
        """将缓冲区帧批量发送到 spark-app。"""
        if not self._buffer:
            return
        batch = self._buffer[: self.BATCH_SIZE]
        try:
            ok = self._post_batch(batch)
            if ok:
                self._buffer = self._buffer[len(batch) :]
                self._consecutive_failures = 0
                print(f"[bridge] 发送成功 {len(batch)} 条")
            else:
                self._consecutive_failures += 1
                self._backoff()
        except Exception as e:
            print(f"[bridge] 发送异常: {e}")
            self._consecutive_failures += 1
            self._backoff()

    def _post_batch(self, batch: list) -> bool:
        """POST 批量帧到 /api/ingest/exoskeleton/batch。"""
        url = f"{self.spark_url}/api/ingest/exoskeleton/batch"
        body = json.dumps({"frames": batch}).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.ingest_key:
            headers["X-Ingest-Key"] = self.ingest_key
        if self.org_id:
            headers["X-Org-Id"] = self.org_id
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:  # nosec B310 - configured internal HTTP client
                if 200 <= resp.status < 300:
                    return True
                print(f"[bridge] HTTP {resp.status}")
                return False
        except urllib.error.URLError as e:
            print(f"[bridge] 连接失败: {e}")
            return False

    def _backoff(self):
        """指数退避，最大 60s。"""
        delay = min(2 ** min(self._consecutive_failures, 6), self.MAX_BACKOFF_SEC)
        print(f"[bridge] {delay}s 后重试（连续失败 {self._consecutive_failures}）...")
        time.sleep(delay)


# ===== 主入口 =====


def main():
    parser = argparse.ArgumentParser(
        description="边缘侧到 spark-app 数据桥接（外骨骼数据上行）",
    )
    parser.add_argument("--spark-url", required=True, help="spark-app 地址，如 http://localhost:3000")
    parser.add_argument("--ingest-key", default="", help="Ingestion API Key（对应 X-Ingest-Key header）")
    parser.add_argument("--org-id", default="", help="目标组织 ID（对应 X-Org-Id header）")
    parser.add_argument("--device-config", default="", help="设备配置文件路径（JSON，真机模式）")
    parser.add_argument(
        "--source-type",
        default="simulated",
        choices=["real", "controlled_test", "simulated"],
        help="数据来源类型（默认 simulated）",
    )
    parser.add_argument("--device-id", default="EXO-SIM-001", help="模拟模式设备ID（默认 EXO-SIM-001）")
    parser.add_argument("--worker-id", default="P-SIM-001", help="模拟模式工人ID（默认 P-SIM-001）")
    parser.add_argument("--interval-ms", type=int, default=1000, help="模拟模式帧间隔毫秒（默认 1000）")
    args = parser.parse_args()

    # 选择数据源
    if args.source_type == "simulated":
        source = SimulatedExoSource(
            device_id=args.device_id,
            worker_id=args.worker_id,
            interval_ms=args.interval_ms,
        )
        print(f"[bridge] 模拟模式: device={args.device_id}, interval={args.interval_ms}ms")
    else:
        if not args.device_config:
            print("[bridge] 真机模式需要 --device-config 参数")
            sys.exit(1)
        source = RealExoSource(device_config=args.device_config)
        print(f"[bridge] 真机模式: config={args.device_config}")

    bridge = SparkBridge(
        spark_url=args.spark_url,
        ingest_key=args.ingest_key,
        source=source,
        org_id=args.org_id,
    )
    bridge.run()


if __name__ == "__main__":
    main()
