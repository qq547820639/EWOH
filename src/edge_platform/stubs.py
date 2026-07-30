#!/usr/bin/env python3
"""依赖契约 stub（仅用于联调前自测，签名与并行开发模块一致，不得作为交付实现）。
包含：Storage / Bus / AdapterManager / InferencePipeline / ModelRegistry / RuleEngine 契约替身，
以及一个向 StubStorage 写入 simulated 来源数据的演示发生器。
"""
import json
import queue
import random
import sqlite3
import threading
import time
import uuid
from datetime import datetime

SCHEMA = """
CREATE TABLE IF NOT EXISTS person (
  person_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, team TEXT,
  skills_json TEXT NOT NULL DEFAULT '[]', consent_status TEXT NOT NULL DEFAULT 'unknown',
  active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS device (
  device_id TEXT PRIMARY KEY, device_type TEXT NOT NULL, model TEXT NOT NULL,
  firmware_version TEXT, person_id TEXT, online INTEGER NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL, last_seen TEXT);
CREATE TABLE IF NOT EXISTS telemetry (
  record_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, ts TEXT NOT NULL, seq INTEGER,
  payload_json TEXT NOT NULL, quality_status TEXT NOT NULL, source_type TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_telemetry_device_ts ON telemetry(device_id, ts);
CREATE TABLE IF NOT EXISTS inference (
  inference_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, ts_start TEXT NOT NULL, ts_end TEXT NOT NULL,
  label TEXT NOT NULL, confidence REAL, model_id TEXT, model_version TEXT,
  evidence_json TEXT, source_type TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS risk_event (
  event_id TEXT PRIMARY KEY, event_code TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL,
  person_id TEXT, device_id TEXT, task_id TEXT, zone_id TEXT, start_time TEXT NOT NULL, end_time TEXT,
  trigger_json TEXT NOT NULL, evidence_json TEXT NOT NULL, source_type TEXT NOT NULL, handling_json TEXT);
"""


def _now():
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


class Storage:
    """契约：edge/storage.py class Storage(db_path) 的 stub 实现（SQLite 持久化）。"""

    def __init__(self, db_path):
        self.db_path = str(db_path)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.db_path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self.init_db()

    def init_db(self):
        with self._lock, self._db:
            self._db.executescript(SCHEMA)

    def close(self):
        self._db.close()

    # -- 遥测 --
    def insert_telemetry(self, msg):
        with self._lock, self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO telemetry VALUES (?,?,?,?,?,?,?)",
                (msg["record_id"], msg["device_id"], msg["timestamp"], msg.get("sequence", 0),
                 json.dumps(msg.get("telemetry", {}), ensure_ascii=False),
                 msg.get("quality", {}).get("status", "good"), msg["source_type"]))
            self._db.execute("UPDATE device SET last_seen=?, online=1 WHERE device_id=?",
                             (msg["timestamp"], msg["device_id"]))

    def latest_telemetry(self, device_id):
        row = self._db.execute("SELECT * FROM telemetry WHERE device_id=? ORDER BY ts DESC LIMIT 1",
                               (device_id,)).fetchone()
        return self._tele_row(row)

    def query_telemetry(self, device_id, start, end, limit):
        rows = self._db.execute(
            "SELECT * FROM telemetry WHERE device_id=? AND ts BETWEEN ? AND ? ORDER BY ts LIMIT ?",
            (device_id, start, end, int(limit))).fetchall()
        return [self._tele_row(r) for r in rows]

    def export_slice(self, device_id, start, end):
        records = self.query_telemetry(device_id, start, end, 100000)
        return {"device_id": device_id, "start": start, "end": end,
                "record_count": len(records), "records": records,
                "source_type": records[0]["source_type"] if records else None}

    @staticmethod
    def _tele_row(row):
        if not row:
            return None
        return {"record_id": row["record_id"], "device_id": row["device_id"],
                "timestamp": row["ts"], "sequence": row["seq"],
                "telemetry": json.loads(row["payload_json"]),
                "quality": {"status": row["quality_status"]}, "source_type": row["source_type"]}

    # -- 设备 / 人员 --
    def list_devices(self):
        return [dict(r) for r in self._db.execute("SELECT * FROM device").fetchall()]

    def list_people(self):
        return [dict(r) for r in self._db.execute("SELECT * FROM person").fetchall()]

    def upsert_device(self, **d):
        with self._lock, self._db:
            self._db.execute("INSERT OR REPLACE INTO device VALUES (?,?,?,?,?,?,?,?)",
                             (d["device_id"], d.get("device_type", "exoskeleton"), d.get("model", ""),
                              d.get("firmware_version"), d.get("person_id"), int(d.get("online", 0)),
                              d["source_type"], d.get("last_seen")))

    def upsert_person(self, **p):
        with self._lock, self._db:
            self._db.execute("INSERT OR REPLACE INTO person VALUES (?,?,?,?,?,?)",
                             (p["person_id"], p["display_name"], p.get("team"),
                              json.dumps(p.get("skills", []), ensure_ascii=False),
                              p.get("consent_status", "granted"), int(p.get("active", 1))))

    # -- 推理 --
    def insert_inference(self, res):
        with self._lock, self._db:
            self._db.execute("INSERT OR REPLACE INTO inference VALUES (?,?,?,?,?,?,?,?,?,?)",
                             (res["inference_id"], res["device_id"], res["ts_start"], res["ts_end"],
                              res["label"], res.get("confidence"), res.get("model_id"),
                              res.get("model_version"),
                              json.dumps(res.get("meta", {}), ensure_ascii=False), res["source_type"]))

    def query_inference(self, device_id, start, end, limit):
        rows = self._db.execute(
            "SELECT * FROM inference WHERE device_id=? AND ts_end BETWEEN ? AND ? ORDER BY ts_end LIMIT ?",
            (device_id, start, end, int(limit))).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["meta"] = json.loads(d.pop("evidence_json") or "{}")
            out.append(d)
        return out

    # -- 事件 --
    def insert_event(self, evt):
        with self._lock, self._db:
            self._db.execute("INSERT OR REPLACE INTO risk_event VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                             (evt["event_id"], evt["event_code"], evt["severity"], evt.get("status", "open"),
                              evt.get("person_id"), evt.get("device_id"), evt.get("task_id"), evt.get("zone_id"),
                              evt["start_time"], evt.get("end_time"),
                              json.dumps(evt.get("trigger", {}), ensure_ascii=False),
                              json.dumps(evt.get("evidence", {}), ensure_ascii=False),
                              evt["source_type"], json.dumps(evt.get("handling"), ensure_ascii=False)))

    def list_events(self, limit):
        rows = self._db.execute("SELECT * FROM risk_event ORDER BY start_time DESC LIMIT ?",
                                (int(limit),)).fetchall()
        return [self._evt_row(r) for r in rows]

    def get_event(self, eid):
        row = self._db.execute("SELECT * FROM risk_event WHERE event_id=?", (eid,)).fetchone()
        return self._evt_row(row)

    def update_event_status(self, eid, status, handling):
        with self._lock, self._db:
            self._db.execute("UPDATE risk_event SET status=?, handling_json=? WHERE event_id=?",
                             (status, json.dumps(handling, ensure_ascii=False), eid))

    @staticmethod
    def _evt_row(row):
        if not row:
            return None
        d = dict(row)
        d["trigger"] = json.loads(d.pop("trigger_json"))
        d["evidence"] = json.loads(d.pop("evidence_json"))
        d["handling"] = json.loads(d.pop("handling_json") or "null")
        return d

    def counts(self):
        def n(t):
            return self._db.execute("SELECT COUNT(*) c FROM %s" % t).fetchone()["c"]
        return {"person": n("person"), "device": n("device"), "telemetry": n("telemetry"),
                "inference": n("inference"), "risk_event": n("risk_event")}

    def reset_demo(self):
        """演示重置：清空 simulated/controlled_test 来源数据与设备在线状态（stub 专用钩子）。"""
        with self._lock, self._db:
            for t in ("telemetry", "inference", "risk_event"):
                self._db.execute("DELETE FROM %s WHERE source_type!='real'" % t)
            self._db.execute("UPDATE device SET online=0 WHERE source_type!='real'")


class Bus:
    """契约：edge/bus.py 的 stub。"""
    def __init__(self):
        self._subs = {}
        self._lock = threading.Lock()

    def subscribe(self, topic):
        q = queue.Queue(maxsize=1000)
        with self._lock:
            self._subs.setdefault(topic, []).append(q)
        return q

    def publish(self, topic, msg):
        with self._lock:
            for q in self._subs.get(topic, []):
                try:
                    q.put_nowait(msg)
                except queue.Full:
                    pass


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
    def __init__(self, storage, bus, registry, rules):
        self.storage, self.bus, self.registry, self.rules = storage, bus, registry, rules
        self._lat = []

    def start(self):
        pass

    def stop(self):
        pass

    def latency_stats(self):
        lat = sorted(self._lat) or [0]
        return {"count": len(self._lat),
                "p50_ms": round(lat[len(lat) // 2], 1),
                "p95_ms": round(lat[min(len(lat) - 1, int(len(lat) * 0.95))], 1)}


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
                msg = {"record_id": "TS-%s-%07d" % (dev, self._seq[dev]), "device_id": dev,
                       "timestamp": ts, "sequence": self._seq[dev], "source_type": "simulated",
                       "telemetry": {"pitch_deg": round(prof["pitch"] + random.uniform(-1.5, 1.5), 1),
                                     "gyro_dps": round(max(0, prof["gyro"] + random.uniform(-5, 5)), 1),
                                     "load_score": round(load, 3),
                                     "fatigue_trend": round(min(1, 0.2 + t / 2400 + load * 0.3), 3),
                                     "assist_level": round(min(0.8, load * 0.7), 2)},
                       "quality": {"status": "good", "packet_loss_pct": round(random.uniform(0, 0.5), 2)}}
                self.storage.insert_telemetry(msg)
                self.storage.insert_inference({
                    "inference_id": "INF-%s-%07d" % (dev, self._seq[dev]), "device_id": dev,
                    "ts_start": ts, "ts_end": ts, "label": label,
                    "confidence": round(0.9 + random.uniform(-0.03, 0.03), 3),
                    "model_id": "rule-hybrid-stub", "model_version": "stub-0.1",
                    "source_type": "simulated",
                    "meta": {"is_rule": True, "inference_ms": round(random.uniform(2, 8), 1),
                             "data_quality": "good", "window_sec": 2}})
                # 搬举阶段周期性产生一条可控风险事件（演示用）
                if label == "搬举" and dev == self.device_ids[0] and time.time() - self._last_event > 30:
                    self._last_event = time.time()
                    self.storage.insert_event({
                        "event_id": "EVT-" + uuid.uuid4().hex[:8].upper(),
                        "event_code": "LOAD_CONTINUOUS", "severity": "L2", "status": "open",
                        "person_id": "P-001", "device_id": dev, "start_time": ts,
                        "trigger": {"type": "rule", "rule_version": "risk-rule-stub-0.1",
                                    "condition": "连续高负荷滑动窗口超限"},
                        "evidence": {"window_before_sec": 30, "window_after_sec": 30,
                                     "record_id": msg["record_id"], "data_quality": "good"},
                        "source_type": "simulated"})
            time.sleep(self.period)


def seed_base(storage):
    """写入演示基础主数据（人员/设备）；EXO-003 保持离线用于掉线可视验证。"""
    storage.upsert_person(person_id="P-001", display_name="演示人员A", team="月台A",
                          skills=["搬运", "装配"], consent_status="granted")
    storage.upsert_person(person_id="P-002", display_name="演示人员B", team="月台B",
                          skills=["搬运", "拣选"], consent_status="granted")
    storage.upsert_person(person_id="P-003", display_name="演示人员C", team="工位1",
                          skills=["装配", "巡检"], consent_status="granted")
    now = _now()
    storage.upsert_device(device_id="EXO-001", model="NY-EXO-A1", firmware_version="stub-1.0.0",
                          person_id="P-001", online=1, source_type="simulated", last_seen=now)
    storage.upsert_device(device_id="EXO-002", model="NY-EXO-A1", firmware_version="stub-1.0.0",
                          person_id="P-002", online=1, source_type="simulated", last_seen=now)
    storage.upsert_device(device_id="EXO-003", model="NY-EXO-P1", firmware_version="stub-0.9.4",
                          person_id="P-003", online=0, source_type="simulated",
                          last_seen="2026-07-29T00:00:00+08:00")
