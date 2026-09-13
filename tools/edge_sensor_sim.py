#!/usr/bin/env python3
"""多源传感器模拟器：环境 / 摄像头 / UWB → 边缘运行时 → 平台 ingest。

用途
----
没有真实传感器时，用**同一个边缘运行时**（真实适配器 + 真实存储 + 真实
上行桥）把三类传感器帧送进平台，并**按需注入现场常见故障**：

- ``--duplicate-rate``：重复帧（验证平台按 ``(org, record_id)`` 幂等，重放不双写）；
- ``--reorder-rate``：乱序帧（验证"后发先至"不会让旧观测覆盖新观测）；
- ``--drift-future-rate``：未来时间戳（坏时钟；平台显式拒绝 → 边缘转死信）；
- ``--late-rate``：迟到帧（30 分钟前的时间戳；平台标记 ``is_late`` 仍然落库）；
- ``--offline-first-sec``：前 N 秒把上行指向不可达地址（模拟断网）→ 帧进本地
  有界队列 → 恢复后由**同一进程内的新桥实例**从队列补传（跨重启断点续传的
  同一代码路径）。

输出
----
``--stats-json`` 写一份账目：适配器发出的帧数、桥的 received/sent/duplicates/
rejected/buffered、边缘库计数、死信数、队列与死信文件路径。E2E 脚本据此断言
「不丢、不重、可解释」，而不是靠日志猜测。

用法
----
    python tools/edge_sensor_sim.py \
      --platform-url http://127.0.0.1:3100 \
      --ingest-key local-verify-ingest-key-0001 \
      --org-id 00000000-0000-4000-8000-000000000001 \
      --duration-sec 6 --hz 2 --suffix demo1 \
      --duplicate-rate 0.3 --reorder-rate 0.2 --late-rate 0.1 --drift-future-rate 0.1 \
      --offline-first-sec 2 --stats-json /tmp/edge-sim-stats.json

纯 Python 标准库实现。
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if os.path.isdir(os.path.join(_REPO_ROOT, "src", "edge_platform")):
    sys.path.insert(0, os.path.join(_REPO_ROOT, "src"))

from edge_platform.edge.adapters.actuator.simulated import SimulatedActuatorAdapter  # noqa: E402
from edge_platform.edge.adapters.base import BaseAdapter  # noqa: E402
from edge_platform.edge.adapters.camera import SimulatedCameraAdapter  # noqa: E402
from edge_platform.edge.adapters.environment import SimulatedEnvSensorAdapter  # noqa: E402
from edge_platform.edge.adapters.uwb import SimulatedUWBAdapter, UWBBeacon  # noqa: E402
from edge_platform.edge.bridge.sensor_uplink import SensorUplinkBridge  # noqa: E402
from edge_platform.edge.bus import MessageBus  # noqa: E402
from edge_platform.edge.manager import AdapterManager  # noqa: E402
from edge_platform.edge.storage import Storage  # noqa: E402
from edge_platform.runtime.protocols import STREAM_SENSOR_FRAMES  # noqa: E402

#: 断网阶段使用的不可达地址（触发真实的连接失败与离线缓冲路径）。
OFFLINE_URL = "http://127.0.0.1:9"


def _now() -> datetime:
    return datetime.now(timezone.utc)


class FaultInjectingAdapter(BaseAdapter):
    """包一层适配器：把真实适配器产出的帧按概率注入现场故障。

    只改**帧流**，不改适配器本身：重复帧 = 同一帧发两次（平台靠 record_id 去重）、
    乱序 = 暂存一帧延后发出、时间注入 = 改写 ts（坏时钟/迟到）。
    """

    def __init__(self, inner: BaseAdapter, rng: random.Random, duplicate_rate=0.0,
                 reorder_rate=0.0, late_rate=0.0, drift_future_rate=0.0):
        super().__init__(
            device_id=inner.device_id,
            source_type=getattr(inner, "source_type", "simulated"),
            model=getattr(inner, "model", ""),
            firmware_version=getattr(inner, "firmware_version", ""),
        )
        self._inner = inner
        self._rng = rng
        self._duplicate_rate = duplicate_rate
        self._reorder_rate = reorder_rate
        self._late_rate = late_rate
        self._drift_future_rate = drift_future_rate
        self._pending_duplicate: list[dict] = []
        self._held: dict | None = None
        self._lock = threading.Lock()
        self.counters = {"emitted": 0, "duplicated": 0, "reordered": 0, "late": 0, "drift_future": 0}

    # ---- 生命周期：委托给内层适配器 ----
    def start(self):
        self._running = True
        self._started_at = _now().isoformat()
        self._inner.start()

    def stop(self):
        self._running = False
        self._inner.stop()

    def reconnect(self):
        return self._inner.reconnect()

    def health(self):
        base = dict(self._inner.health() or {})
        base.update({"fault_injection": dict(self.counters), "device_id": self.device_id})
        return base

    def _mutate_time(self, frame: dict) -> dict:
        """按概率注入坏时钟（未来 +45min）或迟到（-30min），返回新帧。"""
        key = "ts" if "ts" in frame else "event_time"
        if self._rng.random() < self._drift_future_rate:
            frame[key] = (_now() + timedelta(minutes=45)).isoformat()
            self.counters["drift_future"] += 1
        elif self._rng.random() < self._late_rate:
            frame[key] = (_now() - timedelta(minutes=30)).isoformat()
            self.counters["late"] += 1
        return frame

    def read_message(self, timeout=None):
        with self._lock:
            if self._pending_duplicate:
                self.counters["duplicated"] += 1
                return dict(self._pending_duplicate.pop(0))
            if self._held is not None:
                frame, self._held = self._held, None
                return frame
        frame = self._inner.read_message(timeout=timeout)
        if frame is None:
            return None
        frame = dict(frame)
        frame = self._mutate_time(frame)
        with self._lock:
            if self._rng.random() < self._duplicate_rate:
                # 同一帧再发一次（内容一致 → record_id 一致 → 平台幂等命中）
                self._pending_duplicate.append(dict(frame))
            if self._rng.random() < self._reorder_rate:
                self._held = dict(frame)
                self.counters["reordered"] += 1
                return None
            self.counters["emitted"] += 1
        return frame


class BadFrameAdapter(BaseAdapter):
    """故意产出不可归一化帧（验证边缘死信留痕，而非静默丢弃）。"""

    def __init__(self, device_id: str, count: int):
        super().__init__(device_id=device_id, source_type="simulated", model="bad-frame-injector")
        self._frames = [
            {"foo": f"bar-{index}", "note": "未登记类别（模拟固件字段漂移）"}
            for index in range(max(0, count))
        ]

    def start(self):
        self._running = True
        self._started_at = _now().isoformat()
        return True

    def stop(self):
        self._running = False
        return True

    def reconnect(self):
        return True

    def read_message(self, timeout=None):
        if self._frames:
            return self._frames.pop(0)
        time.sleep(min(0.01, timeout or 0.01))
        return None

    def health(self):
        return {"device_id": self.device_id, "status": "online", "type": "bad-frame-injector"}


def build_adapters(args) -> list[FaultInjectingAdapter]:
    # 固定种子的伪随机只用于**模拟数据与故障注入**，不涉及任何安全用途
    rng = random.Random(args.seed)  # nosec B311 - simulation-only randomness
    suffix = args.suffix
    inner: list[BaseAdapter] = []
    inner.extend([
        SimulatedEnvSensorAdapter(
            sensor_id=f"ENV-SIM-{suffix}", station_id=f"ST-SIM-{suffix}", hz=args.hz,
            source_type="simulated",
        ),
        SimulatedCameraAdapter(
            camera_id=f"CAM-SIM-{suffix}", hz=args.hz, track_ids=[f"T{suffix}-1", f"T{suffix}-2"],
            source_type="simulated",
        ),
        SimulatedUWBAdapter(
            device_id=f"UWB-SIM-{suffix}",
            tag_id=f"TAG-SIM-{suffix}",
            person_id=args.person_id,
            path=[(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (2.0, 0.0, 0.0)],
            beacons=[UWBBeacon("B1", 0.0, 0.0), UWBBeacon("B2", 5.0, 0.0)],
            hz=args.hz,
            source_type="simulated",
        ),
    ])
    if getattr(args, "with_actuator", False):
        # NO-59b：执行机构（AGV）模拟设备——让"执行层"也有真实上行（状态/位置/授权号），
        # 走同一条归一化 + 上行桥 + 平台摄入链路。
        # 注意：必须**追加在最后**——三类适配器共享同一个故障注入 RNG，
        # 插到前面会改变既有环境/摄像头/定位帧的注入模式（场景确定性靠抽取顺序）。
        inner.append(
            SimulatedActuatorAdapter(
                device_id=f"AGV-SIM-{suffix}",
                stations=[
                    (f"ST-SIM-{suffix}-1", 3.0, 0.0),
                    (f"ST-SIM-{suffix}-2", 3.0, 4.0),
                    ("DOCK", 0.0, 0.0),
                ],
                hz=args.hz,
                source_type="simulated",
            )
        )
    return [
        FaultInjectingAdapter(
            adapter,
            rng,
            duplicate_rate=args.duplicate_rate,
            reorder_rate=args.reorder_rate,
            late_rate=args.late_rate,
            drift_future_rate=args.drift_future_rate,
        )
        for adapter in inner
    ]


def run(args) -> int:
    workdir = args.workdir or tempfile.mkdtemp(prefix="ewoh-edge-sim-")
    os.makedirs(workdir, exist_ok=True)
    db_path = os.path.join(workdir, f"edge-{args.suffix}.db")
    queue_path = os.path.join(workdir, f"edge-{args.suffix}.sensor-uplink-queue.jsonl")

    storage = Storage(db_path)
    storage.init_db()
    bus = MessageBus()
    # 账目基准：管理器**实际发布**到 STREAM_SENSOR_FRAMES 的归一化信封数。
    # （适配器"产出"的帧可能还躺在适配器 inbox 里没被读到——用产出数对账会把
    #   正常停机误判成丢帧。）
    published: list[dict] = []
    bus.subscribe(STREAM_SENSOR_FRAMES, published.append)
    manager = AdapterManager(storage=storage, bus=bus)
    adapters = build_adapters(args)
    for adapter in adapters:
        manager.register(adapter)
    if args.bad_frames > 0:
        manager.register(BadFrameAdapter(f"BROKEN-SIM-{args.suffix}", args.bad_frames))

    bridge_holder: dict[str, Any] = {"bridge": None}
    phase_stats: list[dict] = []

    def make_bridge(url: str) -> SensorUplinkBridge:
        bridge = SensorUplinkBridge(
            bus,
            url,
            ingest_key=args.ingest_key,
            org_id=args.org_id,
            queue_path=queue_path,
        )
        bridge.start()
        return bridge

    adapters_stopped = False
    try:
        # 先起上行桥，再起采集：反过来会出现"已发布但无人订阅"的空窗（实测丢 2 帧）。
        if args.offline_first_sec > 0:
            # 阶段 1：断网（不可达地址）→ 帧进有界队列
            bridge = make_bridge(OFFLINE_URL)
            bridge_holder["bridge"] = bridge
            manager.start()
            time.sleep(args.offline_first_sec)
            phase_stats.append(
                {"phase": "offline", "seconds": args.offline_first_sec, "health": bridge.health()}
            )
            print(f"[sim] 断网阶段结束：缓冲 {bridge.health()['buffer']} 条（已落盘 {queue_path}）")
            # 阶段 2：恢复 —— **原地 retarget**（同一实例/同一订阅/同一队列）：
            # 换实例会造成订阅空窗（空窗期发布的帧无人接收）或双写同一队列文件。
            bridge.retarget(args.platform_url)
            online = bridge
        else:
            online = make_bridge(args.platform_url)
            manager.start()
        bridge_holder["bridge"] = online
        remaining = max(0.5, args.duration_sec - args.offline_first_sec)
        time.sleep(remaining)
        # 先停采集（不再有新帧发布），再排空队列——否则"排空"与持续采集竞争，
        # buffer 永远不会归零，账目无法判定。
        manager.stop()
        for adapter in adapters:
            try:
                adapter.stop()
            except Exception as exc:  # noqa: BLE001 - 停机路径：单台设备停止失败不应阻断整体停机
                print(f"[sim] 停机时适配器停止失败（继续）：{adapter.device_id}: {exc}")
        adapters_stopped = True
        deadline = time.time() + args.drain_timeout_sec
        while time.time() < deadline and online.health()["buffer"] > 0:
            if not online.flush_once():
                time.sleep(0.2)
        online.stop()
        phase_stats.append({"phase": "online", "seconds": round(remaining, 2), "health": online.health()})
    finally:
        if not adapters_stopped:
            manager.stop()
            for adapter in adapters:
                try:
                    adapter.stop()
                except Exception as exc:  # noqa: BLE001 - 同上：清理路径不掩盖主异常
                    print(f"[sim] 清理时适配器停止失败：{adapter.device_id}: {exc}")

    bridge = bridge_holder["bridge"]
    # 账目闭合（把等式的两边都算出来，让运维/E2E 不必自己拼）：
    #   1) 无进程内丢失：published == Σ ph.received
    #   2) 每条都有归属：received + replayed == sent + duplicates + rejected + buffer + dropped_*
    # 本脚本只用**一个**桥实例（断网→恢复走 retarget），因此最终 health 就是权威：
    # 阶段快照仅用于叙述，不能相加（否则同一计数器被重复计入）。
    # 先等在途上行收敛再算最终账目：最后一次 flush 的 HTTP 应答可能仍在路上，
    # 直接取值会把"在途"误报成"未闭合"（2026-09-11 实测：同一命令时而 closed=true
    # 时而 false，E2E 因此间歇失败）。等待有界（最多 3s），并在统计里如实标出是否等到稳态。
    settle_deadline = time.time() + 3.0
    settle_stable_since = time.time()
    settle_last = None
    while bridge is not None and time.time() < settle_deadline:
        current = (bridge.health()["stats"].get("received", 0), bridge.health()["stats"].get("replayed", 0))
        if current != settle_last:
            settle_last = current
            settle_stable_since = time.time()
        elif time.time() - settle_stable_since >= 0.3:
            break
        time.sleep(0.1)
    final_health = bridge.health() if bridge else {"stats": {}, "buffer": 0}
    final_stats = final_health["stats"]
    accounted = (
        final_stats.get("sent", 0) + final_stats.get("duplicates", 0) + final_stats.get("rejected", 0)
        + final_health.get("buffer", 0) + final_stats.get("dropped_invalid", 0)
        + final_stats.get("dropped_overflow", 0)
    )
    accounting = {
        "published": len(published),
        "bridge_received": final_stats.get("received", 0),
        "bridge_replayed": final_stats.get("replayed", 0),
        "bridge_accounted": accounted,
        "no_in_process_loss": len(published) == final_stats.get("received", 0),
        "settled": time.time() < settle_deadline or settle_last == (
            final_stats.get("received", 0),
            final_stats.get("replayed", 0),
        ),
        "closed": final_stats.get("received", 0) + final_stats.get("replayed", 0) == accounted,
        "phase_snapshots": [
            {"phase": p["phase"], "seconds": p["seconds"], "buffer": p["health"]["buffer"]}
            for p in phase_stats
        ],
    }
    stats = {
        "suffix": args.suffix,
        "platform_url": args.platform_url,
        "workdir": workdir,
        "db_path": db_path,
        "queue_path": queue_path,
        "dead_letter_path": f"{queue_path}.dead-letter.jsonl",
        "adapters": {a.device_id: dict(a.counters) for a in adapters},
        "published_frames": len(published),
        "published_by_kind": {
            kind: sum(1 for f in published if f.get("kind") == kind)
            for kind in sorted({str(f.get("kind")) for f in published})
        },
        "bridge": bridge.health() if bridge else None,
        "phases": phase_stats,
        "db_counts": storage.counts(),
        "frame_dead_letters": storage.count_frame_dead_letters(),
        "accounting": accounting,
        "manager": {
            "dead_lettered_total": manager.dead_lettered_total,
            "health": manager.health(),
        },
    }
    if args.stats_json:
        with open(args.stats_json, "w", encoding="utf-8") as fh:
            json.dump(stats, fh, ensure_ascii=False, indent=2)
    storage.close()

    print(
        f"[sim] 账目：published={accounting['published']} bridge_received={accounting['bridge_received']}"
        f" closed={accounting['closed']} no_loss={accounting['no_in_process_loss']}"
    )
    print(
        f"[sim] 完成：发布 {stats['published_frames']} 帧 · 桥 sent={stats['bridge']['stats']['sent']}"
        f" duplicates={stats['bridge']['stats']['duplicates']} rejected={stats['bridge']['stats']['rejected']}"
        f" buffer={stats['bridge']['buffer']} · 边缘库 telemetry={stats['db_counts']['telemetry']}"
        f" · 死信 {stats['frame_dead_letters']}"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="多源传感器模拟器（环境/摄像头/UWB → 平台 ingest）")
    parser.add_argument("--platform-url", default=os.environ.get("EWOH_SENSOR_UPLINK_URL", "http://127.0.0.1:3100"))
    parser.add_argument("--ingest-key", default=os.environ.get("EWOH_E2E_INGEST_KEY", "local-verify-ingest-key-0001"))
    parser.add_argument(
        "--org-id",
        default=os.environ.get("EWOH_E2E_INGEST_ORG_ID", "00000000-0000-4000-8000-000000000001"),
    )
    parser.add_argument("--person-id", default=os.environ.get("EWOH_E2E_PERSON_ID", "P001"))
    parser.add_argument("--suffix", default="sim1")
    parser.add_argument("--duration-sec", type=float, default=6.0)
    parser.add_argument("--offline-first-sec", type=float, default=0.0)
    parser.add_argument("--drain-timeout-sec", type=float, default=20.0)
    parser.add_argument("--hz", type=float, default=2.0)
    parser.add_argument("--duplicate-rate", type=float, default=0.0)
    parser.add_argument("--reorder-rate", type=float, default=0.0)
    parser.add_argument("--late-rate", type=float, default=0.0)
    parser.add_argument("--drift-future-rate", type=float, default=0.0)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument(
        "--with-actuator",
        action="store_true",
        help="额外启动执行机构（AGV）模拟设备，验证执行层状态上行（NO-59b）",
    )
    parser.add_argument("--workdir", default="")
    parser.add_argument("--stats-json", default="")
    parser.add_argument(
        "--bad-frames", type=int, default=0,
        help="注入 N 条不可归一化帧（验证死信留痕；默认 0）",
    )
    args = parser.parse_args()
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
