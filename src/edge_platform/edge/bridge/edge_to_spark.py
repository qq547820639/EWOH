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


def _runtime_mode() -> str:
    """UR8：EDGE-041 production 判定（读取失败按 development 宽松，与其他 uplink 一致）。

    本脚本可独立于 edge_platform 包运行（真机模式才导入包），故用 try/except 兜底。
    """
    try:
        from edge_platform.config import Settings

        return Settings.load().runtime_mode
    except Exception:
        return "development"


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
    - UR8（2026-09-13 审查）：云端 4xx（非 429）拒绝的批次转死信文件
      （<queue_path>.dead-letter.jsonl），不再永久阻塞队头——与 event_uplink
      的 P1 整改同款毒信封语义（云端已校验并拒绝，重试不会成功）。
    - UR8：EDGE-041 同款守卫——production 下拒绝经明文 http 发送 X-Ingest-Key。
    """

    BATCH_SIZE = 100
    MAX_BACKOFF_SEC = 60

    def __init__(
        self,
        spark_url: str,
        ingest_key: str = "",
        source: Any = None,
        org_id: str = "",
        queue_path: str = "",
    ):
        # UR8（2026-09-13 审查）：先 strip——urlsplit/urllib 容忍 URL 前后空白
        # （" http://host" 照常发往 http），不 strip 则下方明文 http 守卫被空白
        # 绕过，production 下 X-Ingest-Key 仍走明文。
        self.spark_url = (spark_url or "").strip().rstrip("/")
        self.ingest_key = ingest_key
        self.org_id = org_id
        self.source = source
        self._buffer: list = []
        self._queue_path = queue_path
        self.dead_lettered = 0  # UR8：转死信的帧数（可观测）
        self.disabled_reason = ""  # UR8：EDGE-041 守卫禁用原因（空 = 未禁用）
        if self.spark_url.lower().startswith(("http://", "//")) and _runtime_mode() == "production":
            # scheme 按 RFC 3986 大小写不敏感——先归一再判定，堵 "HTTP://" 旁路。
            self.disabled_reason = "insecure_http_in_production"
            print(
                "[bridge] ERROR: production 下拒绝明文 http 上行"
                f"（X-Ingest-Key 会暴露），已禁用: {self.spark_url}"
            )
        # DATA-FLOW-L2（2026-08-18）：磁盘持久化缓冲——断网/崩溃不丢帧，
        # 启动时断点续传（对齐 event_uplink 的 queue_path 模式；损坏显式 ERROR 空队列启动）。
        if self._queue_path and os.path.exists(self._queue_path):
            try:
                with open(self._queue_path, encoding="utf-8") as fh:
                    loaded = json.load(fh)
                if isinstance(loaded, list):
                    self._buffer = [f for f in loaded if isinstance(f, dict)]
                print(f"[bridge] 队列恢复 {len(self._buffer)} 条（{self._queue_path}）")
            except Exception as exc:
                print(f"[bridge] 队列加载失败（以空队列启动）: {exc}")
        self._running = False
        self._consecutive_failures = 0

    def _persist(self) -> None:
        """未发送队列原子落盘（tmp + rename；queue_path 为空 = 不持久化）。"""
        if not self._queue_path:
            return
        tmp = f"{self._queue_path}.tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self._buffer, fh, ensure_ascii=False)
            os.replace(tmp, self._queue_path)
        except Exception as exc:
            print(f"[bridge] 队列持久化失败: {exc}")

    def run(self):
        """主循环：持续读取帧并尝试发送。"""
        if self.disabled_reason:
            # UR8：EDGE-041 守卫——禁用状态下绝不发出携带凭据的请求。
            print(f"[bridge] 已禁用（{self.disabled_reason}），不启动上行")
            return
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
                self._persist()  # L2：入队即落盘（跨重启断点续传）
                # P2（2026-08-19 审计）批量化修复：原阈值写死 1（"达到批量上限
                # 或单帧模式直接发送"的残尾），每入一帧立即 flush——缓冲恒为 1，
                # BATCH_SIZE=100 名存实亡（等价死代码），洪泛时逐帧 POST 打爆
                # 云端。恢复真实批量语义：攒满 BATCH_SIZE 才主动批量发送；
                # 低速率流由上方 read 超时（frame=None）分支兜底 flush——
                # 正常演示（1 帧/秒）行为不变，洪泛时 100 帧合一批。
                if len(self._buffer) >= self.BATCH_SIZE:
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
        if self.disabled_reason:
            # UR8：守卫在任意发送入口都生效——禁用状态下绝不发出携带凭据的请求。
            print(f"[bridge] 已禁用（{self.disabled_reason}），跳过发送")
            return
        batch = self._buffer[: self.BATCH_SIZE]
        try:
            verdict = self._post_batch(batch)
            if verdict == "ok":
                self._buffer = self._buffer[len(batch) :]
                self._persist()  # L2：发送成功即从磁盘队列移除
                self._consecutive_failures = 0
                print(f"[bridge] 发送成功 {len(batch)} 条")
            elif verdict == "dead_letter":
                # UR8（2026-09-13 审查）：云端 4xx（非 429）= 平台已校验并拒绝，
                # 重试不会成功——转死信文件（人工重放载体；平台按 raw_ref/record_id
                # 幂等，重放安全），队头继续推进，不再永久阻塞其后全部帧。
                self._dead_letter(batch, "云端 4xx 拒绝（非 429/非可重试）")
                self._buffer = self._buffer[len(batch) :]
                self._persist()
                self._consecutive_failures = 0
                print(f"[bridge] {len(batch)} 条转死信（云端 4xx 拒绝，不阻塞队头）")
            else:
                self._consecutive_failures += 1
                self._backoff()
        except Exception as e:
            print(f"[bridge] 发送异常: {e}")
            self._consecutive_failures += 1
            self._backoff()

    def _dead_letter(self, batch: list, reason: str) -> None:
        """UR8：被云端 4xx 拒绝的批次追加到死信文件（人工重放载体）。"""
        self.dead_lettered += len(batch)
        if not self._queue_path:
            print(f"[bridge] ERROR: {len(batch)} 条转死信（无队列路径，仅计数）: {reason}")
            return
        try:
            with open(f"{self._queue_path}.dead-letter.jsonl", "a", encoding="utf-8") as fh:
                for frame in batch:
                    fh.write(json.dumps(frame, ensure_ascii=False) + "\n")
            print(f"[bridge] ERROR: {len(batch)} 条转死信（{reason}）: {self._queue_path}.dead-letter.jsonl")
        except Exception as exc:
            print(f"[bridge] ERROR: 死信写入失败（保留计数）: {exc}")

    def _dead_letter_per_item(self, batch: list, resp) -> None:
        """2xx 批量响应的逐帧对账：accepted=false 的帧转死信（对齐 sensor_uplink 口径）。

        results 与 batch 按位置对位（平台保持请求序）；record_id 两侧都有且不等
        视为错位 → 整批跳过对账（退回整批成功口径，不误判）。
        """
        try:
            payload = json.loads(resp.read().decode() or "{}")
        except Exception:
            return
        results = payload.get("results") if isinstance(payload, dict) else None
        if not isinstance(results, list) or len(results) != len(batch):
            return
        rejected = []
        for frame, item in zip(batch, results):
            if not isinstance(item, dict):
                continue
            rid_ok = (
                item.get("record_id") is None
                or frame.get("record_id") is None
                or str(item.get("record_id")) == str(frame.get("record_id"))
            )
            if not rid_ok:
                continue
            if item.get("accepted") is False and item.get("skipped") is not True:
                rejected.append(frame)
                print(f"[bridge] 帧被平台逐帧拒绝: {item.get('error') or 'accepted=false'}")
        if rejected:
            self._dead_letter(rejected, "批量逐帧拒绝（results.accepted=false，非 skipped）")

    def _post_batch(self, batch: list) -> str:
        """POST 批量帧到 /api/ingest/exoskeleton/batch。

        返回 "ok" / "retry"（瞬态失败）/ "dead_letter"（云端 4xx 非 429 永久拒绝）。

        2026-09-15 仿真对抗收口：2xx 响应含逐帧 results[]（平台可能逐帧拒绝，
        如 CLOCK_DRIFT_FUTURE_TS）。此前 2xx 一律记"发送成功 N 条"，逐帧拒绝的
        帧在本通道彻底消失（无死信、无计数）。现按 results 逐帧对位，拒绝帧转
        本通道死信文件（账目与 sensor_uplink 桥同一口径）；results 缺失/错位时
        退回整批成功口径（不误判）。
        """
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
                    self._dead_letter_per_item(batch, resp)
                    return "ok"
                print(f"[bridge] HTTP {resp.status}")
                return "retry"
        except urllib.error.HTTPError as e:
            # UR8：HTTPError 是 URLError 子类，必须先接——否则 4xx 被当连接失败
            # 无限重试，单个坏帧永久阻塞整条上行队列。
            if 400 <= e.code < 500 and e.code != 429:
                print(f"[bridge] 云端 4xx 拒绝（{e.code}），批次转死信")
                return "dead_letter"
            print(f"[bridge] 上行 HTTP {e.code}（重试）")
            return "retry"
        except urllib.error.URLError as e:
            print(f"[bridge] 连接失败: {e}")
            return "retry"

    def _backoff(self):
        """指数退避，最大 60s；**分片睡眠并响应停止信号**。

        为什么不分片就睡：实测（tests/test_edge_bridge_ingest 挂死复盘）一次 60s 的
        整段 sleep 会吞掉停止请求——桥接器"看起来退出不了"，现场只能 kill -9。
        分片（0.1s）检查 `self._running`：停止信号到达即刻返回，退避节奏不变。
        """
        delay = min(2 ** min(self._consecutive_failures, 6), self.MAX_BACKOFF_SEC)
        print(f"[bridge] {delay}s 后重试（连续失败 {self._consecutive_failures}）...")
        deadline = time.monotonic() + delay
        while self._running and time.monotonic() < deadline:
            time.sleep(min(0.1, max(0.0, deadline - time.monotonic())))


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
    parser.add_argument(
        "--queue-path",
        default=os.path.expanduser("~/.ewoh/edge_to_spark.queue.json"),
        help="未发送帧持久化队列路径（默认 ~/.ewoh/edge_to_spark.queue.json；传空禁用持久化）",
    )
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
        queue_path=args.queue_path,
    )
    bridge.run()


if __name__ == "__main__":
    main()
