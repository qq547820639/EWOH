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
-- Task 17：handling_json 存储 {status(open/handled/closed), handler_id, action, comment,
--   handled_at, end_time, closed_by, close_reason, rule_version}；evidence_json 存储
--   {window_before_sec, window_after_sec, record_ids, data_quality, evidence_window_sec,
--    evidence_quality, evidence_samples, evidence_summary}。
-- Task 14.3：治理与审计表（CREATE TABLE IF NOT EXISTS，幂等，不影响旧表）
CREATE TABLE IF NOT EXISTS device_protocol_version (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  firmware_version TEXT,
  hardware_version TEXT,
  upgraded_at TEXT NOT NULL,
  audit_ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_device_protocol_version_device ON device_protocol_version(device_id);
CREATE TABLE IF NOT EXISTS event_handling (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  handler_id TEXT NOT NULL,
  action TEXT NOT NULL,
  comment TEXT,
  handled_at TEXT NOT NULL,
  audit_ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_handling_event ON event_handling(event_id);
CREATE TABLE IF NOT EXISTS assignment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id TEXT UNIQUE NOT NULL,
  task_id TEXT,
  person_id TEXT NOT NULL,
  device_id TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',
  recommended_by TEXT,
  confirmed_by TEXT,
  confirmed_at TEXT,
  audit_ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_assignment_person ON assignment(person_id);
CREATE INDEX IF NOT EXISTS idx_assignment_status ON assignment(status);
CREATE TABLE IF NOT EXISTS model_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT UNIQUE NOT NULL,
  model_type TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate',
  model_card_uri TEXT,
  registered_at TEXT NOT NULL,
  audit_ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_model_registry_type_status ON model_registry(model_type, status);
CREATE TABLE IF NOT EXISTS rule_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT,
  severity TEXT,
  approver_id TEXT,
  effective_from TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(rule_id, rule_version)
);
CREATE INDEX IF NOT EXISTS idx_rule_registry_enabled ON rule_registry(enabled);
CREATE TABLE IF NOT EXISTS consent_record (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT UNIQUE NOT NULL,
  person_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  granted_by TEXT,
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT,
  audit_ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_consent_record_person ON consent_record(person_id);
CREATE INDEX IF NOT EXISTS idx_consent_record_status ON consent_record(status);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id TEXT UNIQUE NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT,
  target_type TEXT,
  target_id TEXT,
  before_json TEXT,
  after_json TEXT,
  result TEXT,
  request_id TEXT,
  source_ip TEXT,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_action_ts ON audit_log(action, ts);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_ts ON audit_log(actor_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(target_type, target_id);
"""


def _now():
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


class Storage:
    """契约：edge/storage.py class Storage(db_path) 的 stub 实现（SQLite 持久化）。"""

    def __init__(self, db_path):
        self.db_path = str(db_path)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.db_path, check_same_thread=False, timeout=30)
        self._db.row_factory = sqlite3.Row
        # WAL 模式 + busy_timeout 解决模拟器线程与 HTTP 请求线程并发写导致的 "database is locked"
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA busy_timeout=30000")
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
                (
                    msg["record_id"],
                    msg["device_id"],
                    msg["timestamp"],
                    msg.get("sequence", 0),
                    json.dumps(msg.get("telemetry", {}), ensure_ascii=False),
                    msg.get("quality", {}).get("status", "good"),
                    msg["source_type"],
                ),
            )
            self._db.execute(
                "UPDATE device SET last_seen=?, online=1 WHERE device_id=?", (msg["timestamp"], msg["device_id"])
            )

    def latest_telemetry(self, device_id):
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM telemetry WHERE device_id=? ORDER BY ts DESC LIMIT 1", (device_id,)
            ).fetchone()
            return self._tele_row(row)

    def query_telemetry(self, device_id, start, end, limit):
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM telemetry WHERE device_id=? AND ts BETWEEN ? AND ? ORDER BY ts LIMIT ?",
                (device_id, start, end, int(limit)),
            ).fetchall()
            return [self._tele_row(r) for r in rows]

    def export_slice(self, device_id, start, end):
        records = self.query_telemetry(device_id, start, end, 100000)
        return {
            "device_id": device_id,
            "start": start,
            "end": end,
            "record_count": len(records),
            "records": records,
            "source_type": records[0]["source_type"] if records else None,
        }

    @staticmethod
    def _tele_row(row):
        if not row:
            return None
        return {
            "record_id": row["record_id"],
            "device_id": row["device_id"],
            "timestamp": row["ts"],
            "sequence": row["seq"],
            "telemetry": json.loads(row["payload_json"]),
            "quality": {"status": row["quality_status"]},
            "source_type": row["source_type"],
        }

    # -- 设备 / 人员 --
    def list_devices(self):
        with self._lock:
            return [dict(r) for r in self._db.execute("SELECT * FROM device").fetchall()]

    def list_people(self):
        with self._lock:
            return [dict(r) for r in self._db.execute("SELECT * FROM person").fetchall()]

    def upsert_device(self, **d):
        with self._lock, self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO device VALUES (?,?,?,?,?,?,?,?)",
                (
                    d["device_id"],
                    d.get("device_type", "exoskeleton"),
                    d.get("model", ""),
                    d.get("firmware_version"),
                    d.get("person_id"),
                    int(d.get("online", 0)),
                    d["source_type"],
                    d.get("last_seen"),
                ),
            )

    def upsert_person(self, **p):
        with self._lock, self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO person VALUES (?,?,?,?,?,?)",
                (
                    p["person_id"],
                    p["display_name"],
                    p.get("team"),
                    json.dumps(p.get("skills", []), ensure_ascii=False),
                    p.get("consent_status", "granted"),
                    int(p.get("active", 1)),
                ),
            )

    # -- 推理 --
    def insert_inference(self, res):
        with self._lock, self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO inference VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    res["inference_id"],
                    res["device_id"],
                    res["ts_start"],
                    res["ts_end"],
                    res["label"],
                    res.get("confidence"),
                    res.get("model_id"),
                    res.get("model_version"),
                    json.dumps(res.get("meta", {}), ensure_ascii=False),
                    res["source_type"],
                ),
            )

    def query_inference(self, device_id, start, end, limit):
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM inference WHERE device_id=? AND ts_end BETWEEN ? AND ? ORDER BY ts_end LIMIT ?",
                (device_id, start, end, int(limit)),
            ).fetchall()
            out = []
            for r in rows:
                d = dict(r)
                d["meta"] = json.loads(d.pop("evidence_json") or "{}")
                out.append(d)
            return out

    # -- 事件 --
    def insert_event(self, evt):
        with self._lock, self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO risk_event VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    evt["event_id"],
                    evt["event_code"],
                    evt["severity"],
                    evt.get("status", "open"),
                    evt.get("person_id"),
                    evt.get("device_id"),
                    evt.get("task_id"),
                    evt.get("zone_id"),
                    evt["start_time"],
                    evt.get("end_time"),
                    json.dumps(evt.get("trigger", {}), ensure_ascii=False),
                    json.dumps(evt.get("evidence", {}), ensure_ascii=False),
                    evt["source_type"],
                    json.dumps(evt.get("handling"), ensure_ascii=False),
                ),
            )

    def list_events(self, limit):
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM risk_event ORDER BY start_time DESC LIMIT ?", (int(limit),)
            ).fetchall()
            return [self._evt_row(r) for r in rows]

    def get_event(self, eid):
        with self._lock:
            row = self._db.execute("SELECT * FROM risk_event WHERE event_id=?", (eid,)).fetchone()
            return self._evt_row(row)

    def update_event_status(self, eid, status, handling):
        with self._lock, self._db:
            self._db.execute(
                "UPDATE risk_event SET status=?, handling_json=? WHERE event_id=?",
                (status, json.dumps(handling, ensure_ascii=False), eid),
            )

    @staticmethod
    def _evt_row(row):
        if not row:
            return None
        d = dict(row)
        d["trigger"] = json.loads(d.pop("trigger_json"))
        d["evidence"] = json.loads(d.pop("evidence_json"))
        d["handling"] = json.loads(d.pop("handling_json") or "null")
        return d

    # -- Task 14.3：治理与审计表 CRUD --
    @staticmethod
    def _json_dumps_maybe(value):
        """dict/list → json 字符串；str 原样保留；None → None。"""
        if value is None:
            return None
        if isinstance(value, (dict, list)):
            return json.dumps(value, ensure_ascii=False)
        return str(value)

    @staticmethod
    def _json_loads_maybe(value):
        return json.loads(value) if value else None

    def insert_audit_log(
        self,
        action,
        actor_id,
        target_type,
        target_id,
        before=None,
        after=None,
        result="success",
        request_id=None,
        source_ip=None,
    ):
        """写入一条审计日志；返回新记录字典。"""
        audit_id = "AUD-" + uuid.uuid4().hex[:12].upper()
        ts = _now()
        with self._lock, self._db:
            cur = self._db.execute(
                "INSERT INTO audit_log (audit_id, action, actor_id, target_type, target_id,"
                " before_json, after_json, result, request_id, source_ip, ts)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    audit_id,
                    action,
                    actor_id,
                    target_type,
                    target_id,
                    self._json_dumps_maybe(before),
                    self._json_dumps_maybe(after),
                    result,
                    request_id,
                    source_ip,
                    ts,
                ),
            )
            row = self._db.execute("SELECT * FROM audit_log WHERE id=?", (cur.lastrowid,)).fetchone()
        return self._audit_log_row(row)

    def list_audit_logs(self, action=None, actor_id=None, target_type=None, limit=100, offset=0):
        """分页查询审计日志；按 ts DESC, id DESC 排序。"""
        with self._lock:
            clauses, params = [], []
            if action is not None:
                clauses.append("action=?")
                params.append(action)
            if actor_id is not None:
                clauses.append("actor_id=?")
                params.append(actor_id)
            if target_type is not None:
                clauses.append("target_type=?")
                params.append(target_type)
            where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
            sql = "SELECT * FROM audit_log" + where + " ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?"  # nosec B608 - fixed table, parameterized clauses
            params.extend([int(limit), int(offset)])
            rows = self._db.execute(sql, params).fetchall()
            return [self._audit_log_row(r) for r in rows]

    @staticmethod
    def _audit_log_row(row):
        if not row:
            return None
        d = dict(row)
        before_raw = d.pop("before_json")
        after_raw = d.pop("after_json")
        d["before"] = json.loads(before_raw) if before_raw else None
        d["after"] = json.loads(after_raw) if after_raw else None
        return d

    def insert_device_protocol_version(
        self, device_id, protocol_version, firmware_version, hardware_version, audit_ref=None
    ):
        """登记一次设备协议/固件版本升级；返回新记录字典。"""
        upgraded_at = _now()
        with self._lock, self._db:
            cur = self._db.execute(
                "INSERT INTO device_protocol_version"
                " (device_id, protocol_version, firmware_version, hardware_version,"
                " upgraded_at, audit_ref) VALUES (?,?,?,?,?,?)",
                (device_id, protocol_version, firmware_version, hardware_version, upgraded_at, audit_ref),
            )
            row = self._db.execute("SELECT * FROM device_protocol_version WHERE id=?", (cur.lastrowid,)).fetchone()
        return dict(row)

    def list_device_protocol_versions(self, device_id=None):
        """查询设备协议版本登记；可选按 device_id 过滤，按 upgraded_at DESC, id DESC。"""
        with self._lock:
            if device_id is None:
                rows = self._db.execute(
                    "SELECT * FROM device_protocol_version ORDER BY upgraded_at DESC, id DESC"
                ).fetchall()
            else:
                rows = self._db.execute(
                    "SELECT * FROM device_protocol_version WHERE device_id=? ORDER BY upgraded_at DESC, id DESC",
                    (device_id,),
                ).fetchall()
            return [dict(r) for r in rows]

    def insert_event_handling(self, event_id, handler_id, action, comment=None, audit_ref=None):
        """记录一次事件处置动作；返回新记录字典。"""
        handled_at = _now()
        with self._lock, self._db:
            cur = self._db.execute(
                "INSERT INTO event_handling"
                " (event_id, handler_id, action, comment, handled_at, audit_ref)"
                " VALUES (?,?,?,?,?,?)",
                (event_id, handler_id, action, comment, handled_at, audit_ref),
            )
            row = self._db.execute("SELECT * FROM event_handling WHERE id=?", (cur.lastrowid,)).fetchone()
        return dict(row)

    def list_event_handlings(self, event_id=None):
        """查询事件处置记录；可选按 event_id 过滤，按 handled_at DESC, id DESC。"""
        with self._lock:
            if event_id is None:
                rows = self._db.execute("SELECT * FROM event_handling ORDER BY handled_at DESC, id DESC").fetchall()
            else:
                rows = self._db.execute(
                    "SELECT * FROM event_handling WHERE event_id=? ORDER BY handled_at DESC, id DESC", (event_id,)
                ).fetchall()
            return [dict(r) for r in rows]

    def upsert_assignment(
        self,
        assignment_id,
        person_id,
        device_id=None,
        task_id=None,
        status="proposed",
        recommended_by=None,
        confirmed_by=None,
        confirmed_at=None,
        audit_ref=None,
    ):
        """派工记录 upsert（按 assignment_id）；返回最新记录字典。"""
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO assignment (assignment_id, task_id, person_id, device_id, status,"
                " recommended_by, confirmed_by, confirmed_at, audit_ref)"
                " VALUES (?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(assignment_id) DO UPDATE SET"
                " task_id=excluded.task_id, person_id=excluded.person_id,"
                " device_id=excluded.device_id, status=excluded.status,"
                " recommended_by=excluded.recommended_by, confirmed_by=excluded.confirmed_by,"
                " confirmed_at=excluded.confirmed_at, audit_ref=excluded.audit_ref",
                (
                    assignment_id,
                    task_id,
                    person_id,
                    device_id,
                    status,
                    recommended_by,
                    confirmed_by,
                    confirmed_at,
                    audit_ref,
                ),
            )
            row = self._db.execute("SELECT * FROM assignment WHERE assignment_id=?", (assignment_id,)).fetchone()
        return dict(row)

    def list_assignments(self, person_id=None, status=None):
        """查询派工记录；可选按 person_id / status 过滤，按 id DESC。"""
        with self._lock:
            clauses, params = [], []
            if person_id is not None:
                clauses.append("person_id=?")
                params.append(person_id)
            if status is not None:
                clauses.append("status=?")
                params.append(status)
            where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
            sql = "SELECT * FROM assignment" + where + " ORDER BY id DESC"  # nosec B608 - fixed table, parameterized clauses
            rows = self._db.execute(sql, params).fetchall()
            return [dict(r) for r in rows]

    def insert_model_record(self, model_id, model_type, version, status="candidate", model_card_uri=None):
        """登记一个模型版本；返回新记录字典。"""
        registered_at = _now()
        with self._lock, self._db:
            cur = self._db.execute(
                "INSERT INTO model_registry"
                " (model_id, model_type, version, status, model_card_uri, registered_at, audit_ref)"
                " VALUES (?,?,?,?,?,?,?)",
                (model_id, model_type, version, status, model_card_uri, registered_at, None),
            )
            row = self._db.execute("SELECT * FROM model_registry WHERE id=?", (cur.lastrowid,)).fetchone()
        return dict(row)

    def list_models(self, model_type=None, status=None):
        """查询模型注册表；可选按 model_type / status 过滤，按 id DESC。"""
        with self._lock:
            clauses, params = [], []
            if model_type is not None:
                clauses.append("model_type=?")
                params.append(model_type)
            if status is not None:
                clauses.append("status=?")
                params.append(status)
            where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
            sql = "SELECT * FROM model_registry" + where + " ORDER BY id DESC"  # nosec B608 - fixed table, parameterized clauses
            rows = self._db.execute(sql, params).fetchall()
            return [dict(r) for r in rows]

    def insert_rule_record(
        self, rule_id, rule_version, enabled=True, config_json=None, severity=None, approver_id=None
    ):
        """登记一条规则版本；返回新记录字典。config_json 可为 dict 或字符串。"""
        created_at = _now()
        with self._lock, self._db:
            cur = self._db.execute(
                "INSERT INTO rule_registry"
                " (rule_id, rule_version, enabled, config_json, severity, approver_id,"
                " effective_from, created_at) VALUES (?,?,?,?,?,?,?,?)",
                (
                    rule_id,
                    rule_version,
                    int(enabled),
                    self._json_dumps_maybe(config_json),
                    severity,
                    approver_id,
                    None,
                    created_at,
                ),
            )
            row = self._db.execute("SELECT * FROM rule_registry WHERE id=?", (cur.lastrowid,)).fetchone()
        d = dict(row)
        d["config"] = self._json_loads_maybe(d.pop("config_json"))
        return d

    def list_rules(self, enabled=None):
        """查询规则注册表；可选按 enabled 过滤（True/False/None），按 id DESC。"""
        with self._lock:
            if enabled is None:
                rows = self._db.execute("SELECT * FROM rule_registry ORDER BY id DESC").fetchall()
            else:
                rows = self._db.execute(
                    "SELECT * FROM rule_registry WHERE enabled=? ORDER BY id DESC", (int(enabled),)
                ).fetchall()
            out = []
            for r in rows:
                d = dict(r)
                d["config"] = self._json_loads_maybe(d.pop("config_json"))
                out.append(d)
            return out

    def insert_consent_record(
        self,
        record_id,
        person_id,
        purpose,
        granted_by,
        status="active",
        revoked_at=None,
        revoke_reason=None,
        audit_ref=None,
    ):
        """登记一条授权记录；返回新记录字典。"""
        granted_at = _now()
        with self._lock, self._db:
            cur = self._db.execute(
                "INSERT INTO consent_record"
                " (record_id, person_id, purpose, status, granted_by, granted_at,"
                " revoked_at, revoke_reason, audit_ref) VALUES (?,?,?,?,?,?,?,?,?)",
                (record_id, person_id, purpose, status, granted_by, granted_at, revoked_at, revoke_reason, audit_ref),
            )
            row = self._db.execute("SELECT * FROM consent_record WHERE id=?", (cur.lastrowid,)).fetchone()
        return dict(row)

    def list_consent_records(self, person_id=None, status=None):
        """查询授权记录；可选按 person_id / status 过滤，按 id DESC。"""
        with self._lock:
            clauses, params = [], []
            if person_id is not None:
                clauses.append("person_id=?")
                params.append(person_id)
            if status is not None:
                clauses.append("status=?")
                params.append(status)
            where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
            sql = "SELECT * FROM consent_record" + where + " ORDER BY id DESC"  # nosec B608 - fixed table, parameterized clauses
            rows = self._db.execute(sql, params).fetchall()
            return [dict(r) for r in rows]

    def counts(self):
        with self._lock:

            def n(t):
                return self._db.execute(f"SELECT COUNT(*) c FROM {t}").fetchone()["c"]  # nosec B608 - fixed internal table list

            return {
                "person": n("person"),
                "device": n("device"),
                "telemetry": n("telemetry"),
                "inference": n("inference"),
                "risk_event": n("risk_event"),
            }

    def reset_demo(self):
        """演示重置：清空 simulated/controlled_test 来源数据与设备在线状态（stub 专用钩子）。"""
        with self._lock, self._db:
            for t in ("telemetry", "inference", "risk_event"):
                self._db.execute(f"DELETE FROM {t} WHERE source_type!='real'")  # nosec B608 - fixed internal table list
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
