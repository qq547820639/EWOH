#!/usr/bin/env python3
"""依赖契约 stub（仅用于联调前自测，签名与并行开发模块一致，不得作为交付实现）。
包含：Storage / Bus / AdapterManager / InferencePipeline / ModelRegistry / RuleEngine 契约替身，
以及一个向 StubStorage 写入 simulated 来源数据的演示发生器。
"""

import random
import threading
import time
import uuid
from datetime import datetime

# SCHEMA / Storage 已提升至 edge_platform.edge.storage（生产实现），此处兼容引用。
from edge_platform.edge.storage import SCHEMA, Storage  # noqa: E402,F401


def _now():
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


class Bus:
    """契约：edge/bus.py MessageBus 的 stub（统一 handler 回调语义，P0-EDGE-003）。

    与真实 MessageBus 保持同一契约（subscribe(stream, handler) -> sub_id /
    publish(stream, message) 同步回调 / unsubscribe），避免 stub 与真实实现行为分裂。
    """

    def __init__(self):
        self._subs = {}
        self._lock = threading.Lock()
        self.published = {}
        self._handler_errors_total = 0

    def subscribe(self, stream, handler):
        if not callable(handler):
            raise TypeError("handler 必须可调用")
        sub_id = f"{stream}-{uuid.uuid4().hex[:12]}"
        with self._lock:
            self._subs.setdefault(stream, {})[sub_id] = handler
        return sub_id

    def unsubscribe(self, stream, sub_id):
        with self._lock:
            return self._subs.get(stream, {}).pop(sub_id, None) is not None

    def publish(self, stream, msg):
        self.published.setdefault(stream, []).append(msg)
        with self._lock:
            subs = list(self._subs.get(stream, {}).items())
        for _sub_id, handler in subs:
            try:
                handler(msg)
            except Exception:
                self._handler_errors_total += 1


class AdapterManager:
    """契约：edge/manager.py 的 stub。"""

    def __init__(self, storage, bus, listeners=None):
        self.storage, self.bus = storage, bus
        self.listeners = listeners or {9001: "real", 9002: "controlled_test", 9003: "simulated"}
        self.running = False

    def start(self):
        self.running = True

    def stop(self):
        self.running = False


class InferencePipeline:
    """契约：inference/pipeline.py 的 stub。"""

    def __init__(self, storage, bus, registry, rules, metrics_collector=None):
        self.storage, self.bus, self.registry, self.rules = storage, bus, registry, rules
        self._lat = []
        # Task 33：可注入 MetricsCollector（与真实 InferencePipeline 契约对齐）
        self._metrics = metrics_collector

    def start(self):
        pass

    def stop(self):
        pass

    def latency_stats(self):
        lat = sorted(self._lat) or [0]
        return {
            "count": len(self._lat),
            "p50_ms": round(lat[len(lat) // 2], 1),
            "p95_ms": round(lat[min(len(lat) - 1, int(len(lat) * 0.95))], 1),
        }


class ModelRegistry:
    """契约：inference/model.py 的 stub。"""

    def __init__(self, models_dir):
        self.models_dir = str(models_dir)
        self._active = "rule-hybrid-stub-0.1"

    def versions(self):
        return [self._active]

    def active(self):
        return self._active

    def activate(self, v):
        self._active = v

    def rollback(self):
        pass


class RuleEngine:
    """契约：inference/rules.py 的 stub。"""

    def __init__(self, rule_version, config):
        self.rule_version = rule_version
        self.config = config


# ---- 演示数据发生器（simulated 来源，仅工程自测/演示） ----------------------

ACTION_PROFILES = {
    "站立": {"pitch": 3, "gyro": 2, "load": 0.12},
    "行走": {"pitch": 7, "gyro": 38, "load": 0.35},
    "弯腰": {"pitch": 46, "gyro": 18, "load": 0.52},
    "搬举": {"pitch": 28, "gyro": 29, "load": 0.67},
}


class DemoSimulator:
    """模拟器：向 Storage 周期写入 simulated 遥测/推理，并在高负荷时产生事件。"""

    def __init__(self, storage, device_ids=("EXO-001", "EXO-002"), hz=1.0):
        self.storage = storage
        self.device_ids = list(device_ids)
        self.period = 1.0 / hz
        self._stop = threading.Event()
        self._seq = {d: 0 for d in self.device_ids}
        self._last_event = 0

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()

    def stop(self):
        self._stop.set()

    def _run(self):
        t0 = time.time()
        while not self._stop.is_set():
            t = time.time() - t0
            # 相位从「搬举」起跳：演示一启动即产生首条风险事件，事件中心不再空窗 30+ 秒
            label = "搬举" if t % 40 < 8 else "站立" if t % 40 < 23 else "行走" if t % 40 < 33 else "弯腰"
            prof = ACTION_PROFILES[label]
            for dev in self.device_ids:
                self._seq[dev] += 1
                ts = _now()
                load = min(1, max(0, prof["load"] + random.uniform(-0.04, 0.04)))
                msg = {
                    "record_id": f"TS-{dev}-{int(self._seq[dev]):07}",
                    "device_id": dev,
                    "timestamp": ts,
                    "sequence": self._seq[dev],
                    "source_type": "simulated",
                    "telemetry": {
                        "pitch_deg": round(prof["pitch"] + random.uniform(-1.5, 1.5), 1),
                        "gyro_dps": round(max(0, prof["gyro"] + random.uniform(-5, 5)), 1),
                        "load_score": round(load, 3),
                        "fatigue_trend": round(min(1, 0.2 + t / 2400 + load * 0.3), 3),
                        "assist_level": round(min(0.8, load * 0.7), 2),
                    },
                    "quality": {"status": "good", "packet_loss_pct": round(random.uniform(0, 0.5), 2)},
                }
                self.storage.insert_telemetry(msg)
                self.storage.insert_inference(
                    {
                        "inference_id": f"INF-{dev}-{int(self._seq[dev]):07}",
                        "device_id": dev,
                        "ts_start": ts,
                        "ts_end": ts,
                        "label": label,
                        "confidence": round(0.9 + random.uniform(-0.03, 0.03), 3),
                        "model_id": "rule-hybrid-stub",
                        "model_version": "stub-0.1",
                        "source_type": "simulated",
                        "meta": {
                            "is_rule": True,
                            "inference_ms": round(random.uniform(2, 8), 1),
                            "data_quality": "good",
                            "window_sec": 2,
                        },
                    }
                )
                # 搬举阶段周期性产生一条可控风险事件（演示用）
                if label == "搬举" and dev == self.device_ids[0] and time.time() - self._last_event > 30:
                    self._last_event = time.time()
                    self.storage.insert_event(
                        {
                            "event_id": "EVT-" + uuid.uuid4().hex[:8].upper(),
                            "event_code": "LOAD_CONTINUOUS",
                            "severity": "L2",
                            "status": "open",
                            "person_id": "P-001",
                            "device_id": dev,
                            "start_time": ts,
                            "trigger": {
                                "type": "rule",
                                "rule_version": "risk-rule-stub-0.1",
                                "condition": "连续高负荷滑动窗口超限",
                            },
                            "evidence": {
                                "window_before_sec": 30,
                                "window_after_sec": 30,
                                "record_id": msg["record_id"],
                                "data_quality": "good",
                            },
                            "source_type": "simulated",
                        }
                    )
            time.sleep(self.period)


def seed_base(storage):
    """写入演示基础主数据（人员/设备）；EXO-003 保持离线用于掉线可视验证。"""
    storage.upsert_person(
        person_id="P-001", display_name="演示人员A", team="月台A", skills=["搬运", "装配"], consent_status="granted"
    )
    storage.upsert_person(
        person_id="P-002", display_name="演示人员B", team="月台B", skills=["搬运", "拣选"], consent_status="granted"
    )
    storage.upsert_person(
        person_id="P-003", display_name="演示人员C", team="工位1", skills=["装配", "巡检"], consent_status="granted"
    )
    now = _now()
    storage.upsert_device(
        device_id="EXO-001",
        model="NY-EXO-A1",
        firmware_version="stub-1.0.0",
        person_id="P-001",
        online=1,
        source_type="simulated",
        last_seen=now,
    )
    storage.upsert_device(
        device_id="EXO-002",
        model="NY-EXO-A1",
        firmware_version="stub-1.0.0",
        person_id="P-002",
        online=1,
        source_type="simulated",
        last_seen=now,
    )
    storage.upsert_device(
        device_id="EXO-003",
        model="NY-EXO-P1",
        firmware_version="stub-0.9.4",
        person_id="P-003",
        online=0,
        source_type="simulated",
        last_seen="2026-07-29T00:00:00+08:00",
    )
