"""EWOH 边缘持久化层（SQLite 生产实现）。

Storage 是平台唯一完整的 SQLite 持久化实现（遥测/推理/事件/人员/设备/调度/治理
表的 CRUD，线程安全 WAL + busy_timeout）。本模块为生产命名空间；
``edge_platform.stubs`` 保留同名引用仅为测试/演示向后兼容。

2026-08-17 审计整改（EDGE-003/004/005/021/026）：
- exo_binding 全系方法补 self._lock；(exo_id, status='active') 加 partial 唯一索引；
- query_telemetry/query_inference 改 SQL WHERE + BETWEEN + LIMIT（走 device_ts 索引）；
- list_events limit 服务层硬上限 1000；
- SQLite 文件权限收紧 0600。
"""

import hashlib
import json
import os
import sqlite3
import threading
import uuid
from datetime import datetime, timezone

from edge_platform.edge.frame_errors import FrameContractError


def _sha8(text: str) -> str:
    """短摘要（死信 id 用；与归一化层同算法，互不依赖）。

    `usedforsecurity=False`：这是标识符摘要，不是密码学用途（bandit B324）。
    """
    return hashlib.sha1(text.encode("utf-8"), usedforsecurity=False).hexdigest()[:8]

# EDGE-021：list_events 服务层硬上限（路由层另有同值钳制）
MAX_LIST_EVENTS_LIMIT = 1000
MAX_LIST_LIMIT = 1000

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
-- E-08：推理按设备+时间窗查询（原全表扫描）；risk_event 按时间/状态查询
CREATE INDEX IF NOT EXISTS idx_inference_device_ts ON inference(device_id, ts_end);
CREATE TABLE IF NOT EXISTS risk_event (
  event_id TEXT PRIMARY KEY, event_code TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL,
  person_id TEXT, device_id TEXT, task_id TEXT, zone_id TEXT, start_time TEXT NOT NULL, end_time TEXT,
  trigger_json TEXT NOT NULL, evidence_json TEXT NOT NULL, source_type TEXT NOT NULL, handling_json TEXT);
CREATE INDEX IF NOT EXISTS idx_risk_event_start ON risk_event(start_time);
CREATE INDEX IF NOT EXISTS idx_risk_event_status ON risk_event(status);
CREATE INDEX IF NOT EXISTS idx_risk_event_device ON risk_event(device_id);
-- Task 17：handling_json 存储 {status(open/handled/closed), handler_id, action, comment,
--   handled_at, end_time, closed_by, close_reason, rule_version}；evidence_json 存储
--   {window_before_sec, window_after_sec, record_ids, data_quality, evidence_window_sec,
--    evidence_quality, evidence_samples, evidence_summary}。
-- 帧死信（2026-09-10 边缘韧性收口）：不可归一化 / 缺契约字段的帧在此留痕。
-- 此前这类帧只出现在 ERROR 日志里（本地库没有、平台也没有）——现场丢的是数据。
-- 死信行保留原始载荷与原因，供人工重放与计数（绝不静默丢弃）。
CREATE TABLE IF NOT EXISTS frame_dead_letter (
  dead_letter_id TEXT PRIMARY KEY,
  device_id TEXT,
  kind TEXT,
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  source_type TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_frame_dead_letter_created ON frame_dead_letter(created_at);
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
-- ADR-033 / §7：边缘外骨骼绑定事实账（Edge 采集面；云端 ewoh_exo_session 为权威）。
CREATE TABLE IF NOT EXISTS exo_binding (
  binding_id TEXT PRIMARY KEY, exo_id TEXT NOT NULL, person_id TEXT NOT NULL,
  status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
  ended_by TEXT, reason TEXT);
CREATE INDEX IF NOT EXISTS idx_exo_binding_exo ON exo_binding(exo_id);
CREATE INDEX IF NOT EXISTS idx_exo_binding_status ON exo_binding(status);
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
  audit_ref TEXT,
  plan_id TEXT,
  station_id TEXT,
  route_json TEXT,
  planned_start TEXT,
  planned_end TEXT,
  actual_start TEXT,
  actual_end TEXT,
  version INTEGER DEFAULT 1
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
-- 指挥地图智能调度（cmd-map-edge-scheduling）新增表：幂等建表，不影响旧表
CREATE TABLE IF NOT EXISTS task (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT UNIQUE NOT NULL,
  task_type TEXT, priority INTEGER DEFAULT 0, status TEXT DEFAULT 'draft',
  station_id TEXT, zone_id TEXT,
  required_skills_json TEXT NOT NULL DEFAULT '[]',
  required_device_capabilities_json TEXT NOT NULL DEFAULT '[]',
  release_at TEXT, earliest_start TEXT, due_at TEXT,
  estimated_duration_sec INTEGER DEFAULT 0,
  predecessor_task_ids_json TEXT NOT NULL DEFAULT '[]',
  exclusive_resource_ids_json TEXT NOT NULL DEFAULT '[]',
  load_level REAL DEFAULT 0, safety_critical INTEGER DEFAULT 0,
  version INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_status ON task(status);
CREATE INDEX IF NOT EXISTS idx_task_priority ON task(priority);
CREATE TABLE IF NOT EXISTS scheduling_request (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT UNIQUE NOT NULL,
  trigger_type TEXT, task_ids_json TEXT NOT NULL DEFAULT '[]',
  policy_id TEXT, world_state_version TEXT,
  created_at TEXT, expires_at TEXT, status TEXT DEFAULT 'pending', created_by TEXT
);
-- E-08：按状态列出的请求/方案查询（原全表扫描）
CREATE INDEX IF NOT EXISTS idx_scheduling_request_status ON scheduling_request(status);
CREATE TABLE IF NOT EXISTS scheduling_plan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT UNIQUE NOT NULL,
  request_id TEXT, version INTEGER DEFAULT 1,
  objective_score REAL DEFAULT 0, objective_breakdown_json TEXT,
  constraint_summary_json TEXT, world_state_version TEXT,
  valid_until TEXT, status TEXT DEFAULT 'shadow',
  created_at TEXT, confirmed_at TEXT, confirmed_by TEXT, confirm_reason TEXT,
  assignments_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduling_plan_status ON scheduling_plan(status);
CREATE TABLE IF NOT EXISTS scheduling_plan_assignment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT NOT NULL, assignment_id TEXT UNIQUE NOT NULL,
  task_id TEXT, person_id TEXT, device_id TEXT, station_id TEXT,
  route_json TEXT, route_distance_m REAL DEFAULT 0, eta_sec INTEGER DEFAULT 0,
  planned_start TEXT, planned_end TEXT,
  hard_constraints_json TEXT, soft_score_json TEXT,
  score REAL DEFAULT 0, explanation_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_plan_assignment_plan ON scheduling_plan_assignment(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_assignment_person ON scheduling_plan_assignment(person_id);
CREATE TABLE IF NOT EXISTS resource_reservation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id TEXT UNIQUE NOT NULL,
  resource_id TEXT, assignment_id TEXT, plan_id TEXT,
  start_at TEXT, end_at TEXT, expires_at TEXT,
  status TEXT DEFAULT 'active', version INTEGER DEFAULT 1, created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reservation_resource ON resource_reservation(resource_id, status);
CREATE TABLE IF NOT EXISTS schedule_decision (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id TEXT UNIQUE NOT NULL,
  plan_id TEXT, version INTEGER DEFAULT 1,
  action TEXT, actor_id TEXT, reason TEXT,
  before_json TEXT, after_json TEXT, created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_schedule_decision_plan ON schedule_decision(plan_id);
CREATE TABLE IF NOT EXISTS schedule_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id TEXT UNIQUE NOT NULL,
  plan_id TEXT, assignment_id TEXT,
  accepted INTEGER DEFAULT 0, reject_reason TEXT, operator_comment TEXT,
  predicted_json TEXT, actual_json TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS world_state_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id TEXT UNIQUE NOT NULL,
  timestamp TEXT,
  persons_json TEXT, devices_json TEXT, tasks_json TEXT,
  stations_json TEXT, assignments_json TEXT, reservations_json TEXT,
  events_json TEXT, topology_version TEXT, metadata_json TEXT
);
-- E-08：按时间窗口取世界快照（回放/追溯）
CREATE INDEX IF NOT EXISTS idx_world_state_snapshot_ts ON world_state_snapshot(timestamp);
"""


def _now():
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


def _ts_ms(ts):
    """ISO 8601 时间字符串 -> Unix 毫秒（instant 语义，兼容任意时区偏移）。

    与 edge_platform.inference.ts_to_ms 保持同一约定：naive 时间按 UTC 处理；
    无法解析时返回 None。
    """
    s = str(ts).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(round(dt.timestamp() * 1000))


def _in_window(ts, start_ms, end_ms):
    t = _ts_ms(ts)
    return t is not None and start_ms <= t <= end_ms


def _ms_to_iso(ms):
    """Unix 毫秒 → 本地时区 ISO 字符串（与 _now()/services.iso 同构，
    供 SQL 端 ts 文本窗口比较使用）。"""
    return datetime.fromtimestamp(ms / 1000.0).astimezone().isoformat(timespec="milliseconds")


def _ms_to_iso_utc(ms):
    """Unix 毫秒 → UTC 偏移 ISO 字符串（混合偏移格式的第二比较族）。"""
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).isoformat(timespec="milliseconds")


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
        # EDGE-026：库文件含遥测/审计/绑定等敏感数据，显式收紧为 0600
        # （默认 umask 022 会产生 world-readable 文件；:memory: 等无文件场景忽略）。
        try:
            os.chmod(self.db_path, 0o600)
        except OSError:
            pass
        self.init_db()

    def init_db(self):
        with self._lock, self._db:
            self._db.executescript(SCHEMA)
            self._ensure_assignment_columns()
            self._ensure_world_state_snapshot_columns()
            # EDGE-003：(exo_id, status='active') 唯一约束（partial unique index）。
            # 旧库若已存在重复活跃绑定，这是“一人一外骨骼”安全/归属不变量已破坏。
            # 必须启动期 fail-closed；继续运行会让新遥测/任务继续落到不可信归属上。
            self._db.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_exo_binding_one_active "
                "ON exo_binding(exo_id) WHERE status='active'"
            )

    def _ensure_assignment_columns(self):
        """为旧库的 assignment 表补齐调度扩展列（幂等，ALTER 不存在的列会报错故先查）。"""
        cols = {r["name"] for r in self._db.execute("PRAGMA table_info(assignment)").fetchall()}
        additions = {
            "plan_id": "TEXT",
            "station_id": "TEXT",
            "route_json": "TEXT",
            "planned_start": "TEXT",
            "planned_end": "TEXT",
            "actual_start": "TEXT",
            "actual_end": "TEXT",
            "version": "INTEGER DEFAULT 1",
        }
        for name, decl in additions.items():
            if name not in cols:
                self._db.execute(f'ALTER TABLE assignment ADD COLUMN "{name}" {decl}')  # nosec B608 - fixed internal column list

    def _ensure_world_state_snapshot_columns(self):
        """为旧库补齐快照 provenance 列；新旧 Edge SQLite 库均可幂等启动。"""
        columns = {column["name"] for column in self._db.execute("PRAGMA table_info(world_state_snapshot)").fetchall()}
        if "metadata_json" not in columns:
            self._db.execute("ALTER TABLE world_state_snapshot ADD COLUMN metadata_json TEXT")

    def close(self):
        self._db.close()

    # -- 遥测 --
    def ensure_device(self, device_id, device_type, source_type, model=None, firmware_version=None):
        """设备自动登记（幂等）。

        背景：`insert_telemetry` 只 `UPDATE device SET last_seen/online`，
        环境/摄像头/定位设备的 `device` 行从未建立 → 更新命中 0 行 → 设备永远
        不在设备清单里（现场看到"没有设备"，而数据其实一直在进来）。
        这里以 `INSERT OR IGNORE` 显式登记，`model` 未知时写 `unknown`
        （绝不编造型号）；已存在的行不被覆盖（保留人工登记的权威信息）。
        """
        with self._lock, self._db:
            self._db.execute(
                "INSERT OR IGNORE INTO device "
                "(device_id, device_type, model, firmware_version, person_id, online, source_type, last_seen) "
                "VALUES (?,?,?,?,NULL,1,?,NULL)",
                (
                    device_id,
                    device_type or "unknown",
                    model or "unknown",
                    firmware_version,
                    source_type or "unknown",
                ),
            )

    def insert_telemetry(self, msg):
        """写入遥测行（严格契约）。

        缺 `record_id` / `device_id` / `timestamp` / `source_type` 时抛
        :class:`FrameContractError` —— 调用方（AdapterManager）转死信留痕。
        绝不使用 `msg.get()` 兜默认值把"缺字段"伪装成一条正常数据。
        """
        missing = tuple(k for k in ("record_id", "device_id", "timestamp", "source_type") if not msg.get(k))
        if missing:
            raise FrameContractError("telemetry", "遥测行缺必填字段", missing)
        quality = msg.get("quality") if isinstance(msg.get("quality"), dict) else {}
        status = quality.get("status") or "unknown"
        with self._lock, self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO telemetry VALUES (?,?,?,?,?,?,?)",
                (
                    msg["record_id"],
                    msg["device_id"],
                    msg["timestamp"],
                    msg.get("sequence", 0),
                    json.dumps(msg.get("telemetry", {}), ensure_ascii=False),
                    status,
                    msg["source_type"],
                ),
            )
            self._db.execute(
                "UPDATE device SET last_seen=?, online=1 WHERE device_id=?", (msg["timestamp"], msg["device_id"])
            )

    # -- 帧死信（不可归一化帧的留痕与重放载体） --
    def insert_frame_dead_letter(self, entry):
        """记录一条死信；返回 dead_letter_id（幂等：同 record_id 覆盖原因）。

        `dead_letter_id` 优先取来源 record_id（缺失时用 (device, created_at) 摘要），
        因此同一坏帧反复出现只占一行、原因可更新，不会无限膨胀。
        """
        device_id = entry.get("device_id")
        payload = entry.get("payload")
        payload_json = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False, default=str)
        created_at = entry.get("created_at") or datetime.now(timezone.utc).isoformat()
        dead_letter_id = entry.get("dead_letter_id") or entry.get("record_id") or (
            f"dl:{_sha8(f'{device_id}|{payload_json}')}"
        )
        with self._lock, self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO frame_dead_letter "
                "(dead_letter_id, device_id, kind, reason, payload_json, source_type, created_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (
                    dead_letter_id,
                    device_id,
                    entry.get("kind"),
                    str(entry.get("reason") or "unspecified"),
                    payload_json,
                    entry.get("source_type"),
                    created_at,
                ),
            )
        return dead_letter_id

    def list_frame_dead_letters(self, limit=100):
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM frame_dead_letter ORDER BY created_at DESC LIMIT ?",
                (max(1, min(int(limit), 1000)),),
            ).fetchall()
        return [dict(row) for row in rows]

    def count_frame_dead_letters(self):
        with self._lock:
            return self._db.execute("SELECT COUNT(*) c FROM frame_dead_letter").fetchone()["c"]

    def latest_telemetry(self, device_id):
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM telemetry WHERE device_id=? ORDER BY ts DESC LIMIT 1", (device_id,)
            ).fetchone()
            return self._tele_row(row)

    def quality_stats(self, device_id):
        """设备遥测数据质量分布（NO-05：/api/devices/{id}/quality 数据源）。

        返回 {quality_status: count}；无数据返回 {}。容错：查询失败返回空
        （上层组合 adapter 计数器后如实报告）。"""
        try:
            with self._lock:
                rows = self._db.execute(
                    "SELECT quality_status, COUNT(*) AS n FROM telemetry "
                    "WHERE device_id=? GROUP BY quality_status",
                    (device_id,),
                ).fetchall()
            return {r["quality_status"]: r["n"] for r in rows}
        except Exception:
            return {}

    def _query_window_rows(self, table, ts_col, device_id, start_ms, end_ms, limit):
        """EDGE-004/005：SQL 端时间窗预过滤（走 device+ts 索引，不再全表扫描）。

        ts 为 ISO 文本，文本序仅在**同偏移族**内等于时间序——对本地偏移与
        UTC 偏移两族分别发一条 BETWEEN 范围查询（均走索引），合并去重后由
        调用方做精确 instant 过滤（_in_window）与排序，保证跨 UTC/本地偏移
        的窗口语义与旧实现一致（TimestampWindowQueryTest 契约）。
        """
        pk = "record_id" if table == "telemetry" else "inference_id"
        rows_by_pk: dict = {}
        with self._lock:
            for lo, hi in (
                (_ms_to_iso(start_ms), _ms_to_iso(end_ms)),
                (_ms_to_iso_utc(start_ms), _ms_to_iso_utc(end_ms)),
            ):
                rows = self._db.execute(
                    f"SELECT * FROM {table} WHERE device_id=? AND {ts_col} BETWEEN ? AND ? "  # nosec B608 - fixed internal table/column
                    f"ORDER BY {ts_col} LIMIT ?",
                    (device_id, lo, hi, int(limit)),
                ).fetchall()
                for r in rows:
                    rows_by_pk[r[pk]] = r
        return list(rows_by_pk.values())

    def query_telemetry(self, device_id, start, end, limit):
        """按设备 + 时间窗查询遥测（EDGE-004：SQL WHERE + BETWEEN + LIMIT 走
        idx_telemetry_device_ts 索引，不再全表拉取后 Python 过滤）。"""
        start_ms, end_ms = _ts_ms(start), _ts_ms(end)
        if start_ms is None or end_ms is None:
            return []
        rows = self._query_window_rows("telemetry", "ts", device_id, start_ms, end_ms, limit)
        matched = [r for r in rows if _in_window(r["ts"], start_ms, end_ms)]
        matched.sort(key=lambda r: _ts_ms(r["ts"]))
        return [self._tele_row(r) for r in matched[: int(limit)]]

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

    def start_binding(self, binding_id, exo_id, person_id, started_at):
        """ADR-033：开始外骨骼绑定（同外骨骼活跃绑定唯一，服务层冲突显式）。

        EDGE-003：写入纳入 self._lock 串行化 + 事务边界；并发重复 bind 由
        idx_exo_binding_one_active 唯一索引兜底（IntegrityError 由调用方转 409）。
        """
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO exo_binding (binding_id, exo_id, person_id, status, started_at) "
                "VALUES (?, ?, ?, 'active', ?)",
                (binding_id, exo_id, person_id, started_at),
            )
        return {
            "binding_id": binding_id, "exo_id": exo_id, "person_id": person_id,
            "status": "active", "started_at": started_at, "ended_at": None,
            "ended_by": None, "reason": None,
        }

    def end_binding(self, binding_id, ended_at, ended_by, reason=""):
        """ADR-033：结束绑定（状态机 active→ended；无行返回 None 显式）。"""
        with self._lock, self._db:
            cur = self._db.execute(
                "UPDATE exo_binding SET status='ended', ended_at=?, ended_by=?, reason=? "
                "WHERE binding_id=? AND status='active'",
                (ended_at, ended_by, reason, binding_id),
            )
            return cur.rowcount > 0

    def get_binding(self, binding_id):
        with self._lock:
            row = self._db.execute(
                "SELECT binding_id, exo_id, person_id, status, started_at, ended_at, "
                "ended_by, reason FROM exo_binding WHERE binding_id=?",
                (binding_id,),
            ).fetchone()
        if not row:
            return None
        return {
            "binding_id": row[0], "exo_id": row[1], "person_id": row[2],
            "status": row[3], "started_at": row[4], "ended_at": row[5],
            "ended_by": row[6], "reason": row[7],
        }

    def list_active_binding_for_exo(self, exo_id):
        with self._lock:
            row = self._db.execute(
                "SELECT binding_id, exo_id, person_id, status, started_at, ended_at, "
                "ended_by, reason FROM exo_binding WHERE exo_id=? AND status='active' "
                "ORDER BY started_at DESC LIMIT 1",
                (exo_id,),
            ).fetchone()
        if not row:
            return None
        return {
            "binding_id": row[0], "exo_id": row[1], "person_id": row[2],
            "status": row[3], "started_at": row[4], "ended_at": row[5],
            "ended_by": row[6], "reason": row[7],
        }

    def list_bindings(self, status=None):
        with self._lock:
            if status:
                rows = self._db.execute(
                    "SELECT binding_id, exo_id, person_id, status, started_at, ended_at, "
                    "ended_by, reason FROM exo_binding WHERE status=? ORDER BY started_at DESC",
                    (status,),
                ).fetchall()
            else:
                rows = self._db.execute(
                    "SELECT binding_id, exo_id, person_id, status, started_at, ended_at, "
                    "ended_by, reason FROM exo_binding ORDER BY started_at DESC",
                ).fetchall()
        return [
            {
                "binding_id": r[0], "exo_id": r[1], "person_id": r[2],
                "status": r[3], "started_at": r[4], "ended_at": r[5],
                "ended_by": r[6], "reason": r[7],
            }
            for r in rows
        ]

    def upsert_person(self, **p):
        """人员 upsert；授权状态缺省必须保持 unknown，禁止默认视为已授权。"""
        with self._lock, self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO person VALUES (?,?,?,?,?,?)",
                (
                    p["person_id"],
                    p["display_name"],
                    p.get("team"),
                    json.dumps(p.get("skills", []), ensure_ascii=False),
                    p.get("consent_status", "unknown"),
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
        """按设备 + 时间窗查询推理（EDGE-005：SQL WHERE + BETWEEN + LIMIT 走
        idx_inference_device_ts 索引）。"""
        start_ms, end_ms = _ts_ms(start), _ts_ms(end)
        if start_ms is None or end_ms is None:
            return []
        rows = self._query_window_rows("inference", "ts_end", device_id, start_ms, end_ms, limit)
        matched = [r for r in rows if _in_window(r["ts_end"], start_ms, end_ms)]
        matched.sort(key=lambda r: _ts_ms(r["ts_end"]))
        out = []
        for r in matched[: int(limit)]:
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
        """按 start_time 倒序列事件。EDGE-021：limit 服务层硬上限 1000，
        防用户传入超大值造成无界查询。"""
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM risk_event ORDER BY start_time DESC LIMIT ?",
                (min(int(limit), MAX_LIST_EVENTS_LIMIT),),
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

    def record_event_status(
        self,
        eid,
        status,
        handling,
        action,
        handler_id,
        audit_ref=None,
    ):
        """原子更新事件状态并追加处置事实账；事件不存在时整体回滚。

        旧路径先 UPDATE 再 INSERT，第二次写入失败会留下只有状态、没有处置
        证据的半事实。这里是状态闭环的关键写入，必须同事务提交。
        """
        handled_at = str(handling.get("handled_at") or _now())
        with self._lock, self._db:
            cur = self._db.execute(
                "UPDATE risk_event SET status=?, handling_json=? WHERE event_id=?",
                (status, json.dumps(handling, ensure_ascii=False), eid),
            )
            if cur.rowcount != 1:
                raise LookupError(f"event not found: {eid}")
            cur = self._db.execute(
                "INSERT INTO event_handling"
                " (event_id, handler_id, action, comment, handled_at, audit_ref)"
                " VALUES (?,?,?,?,?,?)",
                (eid, handler_id, action, handling.get("comment"), handled_at, audit_ref),
            )
            row = self._db.execute("SELECT * FROM event_handling WHERE id=?", (cur.lastrowid,)).fetchone()
        return dict(row)

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
        """分页查询审计日志；limit 有硬上限，防止一次拉取无界审计历史。"""
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
            params.extend([
                max(0, min(int(limit), MAX_LIST_LIMIT)),
                max(0, int(offset)),
            ])
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
        plan_id=None,
        station_id=None,
        route=None,
        planned_start=None,
        planned_end=None,
        actual_start=None,
        actual_end=None,
        version=None,
    ):
        """派工记录 upsert（按 assignment_id）；返回最新记录字典。"""
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO assignment (assignment_id, task_id, person_id, device_id, status,"
                " recommended_by, confirmed_by, confirmed_at, audit_ref, plan_id, station_id,"
                " route_json, planned_start, planned_end, actual_start, actual_end, version)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(assignment_id) DO UPDATE SET"
                " task_id=excluded.task_id, person_id=excluded.person_id,"
                " device_id=excluded.device_id, status=excluded.status,"
                " recommended_by=excluded.recommended_by, confirmed_by=excluded.confirmed_by,"
                " confirmed_at=excluded.confirmed_at, audit_ref=excluded.audit_ref,"
                " plan_id=excluded.plan_id, station_id=excluded.station_id,"
                " route_json=excluded.route_json, planned_start=excluded.planned_start,"
                " planned_end=excluded.planned_end, actual_start=excluded.actual_start,"
                " actual_end=excluded.actual_end, version=excluded.version",
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
                    plan_id,
                    station_id,
                    self._json_dumps_maybe(route),
                    planned_start,
                    planned_end,
                    actual_start,
                    actual_end,
                    version,
                ),
            )
            row = self._db.execute("SELECT * FROM assignment WHERE assignment_id=?", (assignment_id,)).fetchone()
        return self._assignment_row(row)

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
            return [self._assignment_row(r) for r in rows]

    @staticmethod
    def _assignment_row(row):
        if not row:
            return None
        d = dict(row)
        d["route"] = json.loads(d.pop("route_json")) if d.get("route_json") else None
        return d

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

    # ---- 指挥地图智能调度：持久化 CRUD（cmd-map-edge-scheduling）----

    def upsert_task(self, task_id, **t):
        """任务 upsert（按 task_id）。t 可含 task_type/priority/status/station_id/zone_id/
        required_skills/required_device_capabilities/release_at/earliest_start/due_at/
        estimated_duration_sec/predecessor_task_ids/exclusive_resource_ids/load_level/
        safety_critical/version/created_at/updated_at。"""
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO task (task_id, task_type, priority, status, station_id, zone_id,"
                " required_skills_json, required_device_capabilities_json, release_at,"
                " earliest_start, due_at, estimated_duration_sec, predecessor_task_ids_json,"
                " exclusive_resource_ids_json, load_level, safety_critical, version, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(task_id) DO UPDATE SET task_type=excluded.task_type,"
                " priority=excluded.priority, status=excluded.status, station_id=excluded.station_id,"
                " zone_id=excluded.zone_id, required_skills_json=excluded.required_skills_json,"
                " required_device_capabilities_json=excluded.required_device_capabilities_json,"
                " release_at=excluded.release_at, earliest_start=excluded.earliest_start,"
                " due_at=excluded.due_at, estimated_duration_sec=excluded.estimated_duration_sec,"
                " predecessor_task_ids_json=excluded.predecessor_task_ids_json,"
                " exclusive_resource_ids_json=excluded.exclusive_resource_ids_json,"
                " load_level=excluded.load_level, safety_critical=excluded.safety_critical,"
                " version=excluded.version, created_at=excluded.created_at, updated_at=excluded.updated_at",
                (
                    task_id,
                    t.get("task_type", ""),
                    int(t.get("priority", 0) or 0),
                    t.get("status", "draft"),
                    t.get("station_id", ""),
                    t.get("zone_id", ""),
                    json.dumps(t.get("required_skills", []), ensure_ascii=False),
                    json.dumps(t.get("required_device_capabilities", []), ensure_ascii=False),
                    t.get("release_at", ""),
                    t.get("earliest_start", ""),
                    t.get("due_at", ""),
                    int(t.get("estimated_duration_sec", 0) or 0),
                    json.dumps(t.get("predecessor_task_ids", []), ensure_ascii=False),
                    json.dumps(t.get("exclusive_resource_ids", []), ensure_ascii=False),
                    float(t.get("load_level", 0.0) or 0.0),
                    int(bool(t.get("safety_critical", False))),
                    int(t.get("version", 1) or 1),
                    t.get("created_at", ""),
                    t.get("updated_at", ""),
                ),
            )
            return self._task_row(self._db.execute("SELECT * FROM task WHERE task_id=?", (task_id,)).fetchone())

    def get_task(self, task_id):
        with self._lock:
            return self._task_row(self._db.execute("SELECT * FROM task WHERE task_id=?", (task_id,)).fetchone())

    def list_tasks(self, status=None):
        with self._lock:
            if status is None:
                rows = self._db.execute("SELECT * FROM task ORDER BY priority DESC, id ASC").fetchall()
            else:
                rows = self._db.execute(
                    "SELECT * FROM task WHERE status=? ORDER BY priority DESC, id ASC", (status,)
                ).fetchall()
            return [self._task_row(r) for r in rows]

    @staticmethod
    def _task_row(row):
        if not row:
            return None
        d = dict(row)
        d["required_skills"] = json.loads(d.pop("required_skills_json") or "[]")
        d["required_device_capabilities"] = json.loads(d.pop("required_device_capabilities_json") or "[]")
        d["predecessor_task_ids"] = json.loads(d.pop("predecessor_task_ids_json") or "[]")
        d["exclusive_resource_ids"] = json.loads(d.pop("exclusive_resource_ids_json") or "[]")
        d["safety_critical"] = bool(d.get("safety_critical"))
        return d

    def upsert_scheduling_request(self, request_id, **r):
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO scheduling_request (request_id, trigger_type, task_ids_json, policy_id,"
                " world_state_version, created_at, expires_at, status, created_by)"
                " VALUES (?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(request_id) DO UPDATE SET trigger_type=excluded.trigger_type,"
                " task_ids_json=excluded.task_ids_json, policy_id=excluded.policy_id,"
                " world_state_version=excluded.world_state_version, created_at=excluded.created_at,"
                " expires_at=excluded.expires_at, status=excluded.status, created_by=excluded.created_by",
                (
                    request_id,
                    r.get("trigger_type", ""),
                    json.dumps(r.get("task_ids", []), ensure_ascii=False),
                    r.get("policy_id", ""),
                    r.get("world_state_version", ""),
                    r.get("created_at", ""),
                    r.get("expires_at", ""),
                    r.get("status", "pending"),
                    r.get("created_by", ""),
                ),
            )
            return self._sched_request_row(
                self._db.execute("SELECT * FROM scheduling_request WHERE request_id=?", (request_id,)).fetchone()
            )

    def get_scheduling_request(self, request_id):
        with self._lock:
            return self._sched_request_row(
                self._db.execute("SELECT * FROM scheduling_request WHERE request_id=?", (request_id,)).fetchone()
            )

    def list_scheduling_requests(self, status=None):
        with self._lock:
            if status is None:
                rows = self._db.execute("SELECT * FROM scheduling_request ORDER BY id DESC").fetchall()
            else:
                rows = self._db.execute(
                    "SELECT * FROM scheduling_request WHERE status=? ORDER BY id DESC", (status,)
                ).fetchall()
            return [self._sched_request_row(r) for r in rows]

    @staticmethod
    def _sched_request_row(row):
        if not row:
            return None
        d = dict(row)
        d["task_ids"] = json.loads(d.pop("task_ids_json") or "[]")
        return d

    def save_schedule_plan(self, plan_id, **p):
        """保存方案（含 assignments_json 快照）。p 可含 request_id/version/objective_score/
        objective_breakdown/constraint_summary/world_state_version/valid_until/status/
        created_at/confirmed_at/confirmed_by/confirm_reason/assignments。"""
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO scheduling_plan (plan_id, request_id, version, objective_score,"
                " objective_breakdown_json, constraint_summary_json, world_state_version, valid_until,"
                " status, created_at, confirmed_at, confirmed_by, confirm_reason, assignments_json)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(plan_id) DO UPDATE SET request_id=excluded.request_id,"
                " version=excluded.version, objective_score=excluded.objective_score,"
                " objective_breakdown_json=excluded.objective_breakdown_json,"
                " constraint_summary_json=excluded.constraint_summary_json,"
                " world_state_version=excluded.world_state_version, valid_until=excluded.valid_until,"
                " status=excluded.status, created_at=excluded.created_at,"
                " confirmed_at=excluded.confirmed_at, confirmed_by=excluded.confirmed_by,"
                " confirm_reason=excluded.confirm_reason, assignments_json=excluded.assignments_json",
                (
                    plan_id,
                    p.get("request_id", ""),
                    int(p.get("version", 1) or 1),
                    float(p.get("objective_score", 0.0) or 0.0),
                    json.dumps(p.get("objective_breakdown", {}), ensure_ascii=False),
                    json.dumps(p.get("constraint_summary", {}), ensure_ascii=False),
                    p.get("world_state_version", ""),
                    p.get("valid_until", ""),
                    p.get("status", "shadow"),
                    p.get("created_at", ""),
                    p.get("confirmed_at", ""),
                    p.get("confirmed_by", ""),
                    p.get("confirm_reason", ""),
                    json.dumps(p.get("assignments", []), ensure_ascii=False),
                ),
            )

    def get_schedule_plan(self, plan_id):
        with self._lock:
            return self._schedule_plan_row(
                self._db.execute("SELECT * FROM scheduling_plan WHERE plan_id=?", (plan_id,)).fetchone()
            )

    def list_schedule_plans(self, status=None):
        with self._lock:
            if status is None:
                rows = self._db.execute("SELECT * FROM scheduling_plan ORDER BY id DESC").fetchall()
            else:
                rows = self._db.execute(
                    "SELECT * FROM scheduling_plan WHERE status=? ORDER BY id DESC", (status,)
                ).fetchall()
            return [self._schedule_plan_row(r) for r in rows]

    @staticmethod
    def _schedule_plan_row(row):
        if not row:
            return None
        d = dict(row)
        d["objective_breakdown"] = json.loads(d.pop("objective_breakdown_json") or "{}")
        d["constraint_summary"] = json.loads(d.pop("constraint_summary_json") or "{}")
        d["assignments"] = json.loads(d.pop("assignments_json") or "[]")
        return d

    def save_plan_assignment(self, plan_id, a):
        """保存方案内单条排程（scheduling_plan_assignment）。a 为合并后的 dict。"""
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO scheduling_plan_assignment (plan_id, assignment_id, task_id, person_id,"
                " device_id, station_id, route_json, route_distance_m, eta_sec, planned_start,"
                " planned_end, hard_constraints_json, soft_score_json, score, explanation_json)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(assignment_id) DO UPDATE SET plan_id=excluded.plan_id,"
                " task_id=excluded.task_id, person_id=excluded.person_id, device_id=excluded.device_id,"
                " station_id=excluded.station_id, route_json=excluded.route_json,"
                " route_distance_m=excluded.route_distance_m, eta_sec=excluded.eta_sec,"
                " planned_start=excluded.planned_start, planned_end=excluded.planned_end,"
                " hard_constraints_json=excluded.hard_constraints_json,"
                " soft_score_json=excluded.soft_score_json, score=excluded.score,"
                " explanation_json=excluded.explanation_json",
                (
                    plan_id,
                    a.get("assignment_id", "") or a.get("task_id", ""),
                    a.get("task_id", ""),
                    a.get("person_id", ""),
                    a.get("device_id", ""),
                    a.get("station_id", ""),
                    json.dumps(a.get("route", {}), ensure_ascii=False),
                    float(a.get("route_distance_m", 0.0) or 0.0),
                    int(a.get("eta_sec", 0) or 0),
                    a.get("planned_start", ""),
                    a.get("planned_end", ""),
                    json.dumps(a.get("hard_constraint_results", []), ensure_ascii=False),
                    json.dumps(a.get("soft_score_breakdown", {}), ensure_ascii=False),
                    float(a.get("score", 0.0) or 0.0),
                    json.dumps(a.get("explanation", {}), ensure_ascii=False),
                ),
            )

    def list_plan_assignments(self, plan_id=None):
        with self._lock:
            if plan_id is None:
                rows = self._db.execute("SELECT * FROM scheduling_plan_assignment ORDER BY id ASC").fetchall()
            else:
                rows = self._db.execute(
                    "SELECT * FROM scheduling_plan_assignment WHERE plan_id=? ORDER BY id ASC", (plan_id,)
                ).fetchall()
            return [self._plan_assignment_row(r) for r in rows]

    @staticmethod
    def _plan_assignment_row(row):
        if not row:
            return None
        d = dict(row)
        d["route"] = json.loads(d.pop("route_json") or "{}")
        d["hard_constraint_results"] = json.loads(d.pop("hard_constraints_json") or "[]")
        d["soft_score_breakdown"] = json.loads(d.pop("soft_score_json") or "{}")
        d["explanation"] = json.loads(d.pop("explanation_json") or "{}")
        return d

    def upsert_reservation(self, reservation_id, **r):
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO resource_reservation (reservation_id, resource_id, assignment_id, plan_id,"
                " start_at, end_at, expires_at, status, version, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(reservation_id) DO UPDATE SET resource_id=excluded.resource_id,"
                " assignment_id=excluded.assignment_id, plan_id=excluded.plan_id,"
                " start_at=excluded.start_at, end_at=excluded.end_at, expires_at=excluded.expires_at,"
                " status=excluded.status, version=excluded.version, created_at=excluded.created_at",
                (
                    reservation_id,
                    r.get("resource_id", ""),
                    r.get("assignment_id", ""),
                    r.get("plan_id", ""),
                    r.get("start_at", ""),
                    r.get("end_at", ""),
                    r.get("expires_at", ""),
                    r.get("status", "active"),
                    int(r.get("version", 1) or 1),
                    r.get("created_at", ""),
                ),
            )

    def list_reservations(self, status=None):
        with self._lock:
            if status is None:
                rows = self._db.execute("SELECT * FROM resource_reservation ORDER BY id DESC").fetchall()
            else:
                rows = self._db.execute(
                    "SELECT * FROM resource_reservation WHERE status=? ORDER BY id DESC", (status,)
                ).fetchall()
            return [dict(r) for r in rows]

    def get_reservation(self, reservation_id):
        """按 ID 取单条预约（EDGE-116：替代 list_reservations 全表线性扫描）。"""
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM resource_reservation WHERE reservation_id=?", (reservation_id,)
            ).fetchone()
            return dict(row) if row else None

    def insert_schedule_decision(self, decision_id, plan_id, version, action, actor_id, reason, before, after):
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO schedule_decision (decision_id, plan_id, version, action, actor_id,"
                " reason, before_json, after_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    decision_id,
                    plan_id,
                    int(version),
                    action,
                    actor_id,
                    reason,
                    json.dumps(before, ensure_ascii=False) if before is not None else None,
                    json.dumps(after, ensure_ascii=False) if after is not None else None,
                    _now(),
                ),
            )

    def list_schedule_decisions(self, plan_id=None):
        with self._lock:
            if plan_id is None:
                rows = self._db.execute("SELECT * FROM schedule_decision ORDER BY id DESC").fetchall()
            else:
                rows = self._db.execute(
                    "SELECT * FROM schedule_decision WHERE plan_id=? ORDER BY id DESC", (plan_id,)
                ).fetchall()
            out = []
            for r in rows:
                d = dict(r)
                d["before"] = json.loads(d.pop("before_json")) if d.get("before_json") else None
                d["after"] = json.loads(d.pop("after_json")) if d.get("after_json") else None
                out.append(d)
            return out

    def upsert_schedule_feedback(self, feedback_id, **f):
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO schedule_feedback (feedback_id, plan_id, assignment_id, accepted,"
                " reject_reason, operator_comment, predicted_json, actual_json, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(feedback_id) DO UPDATE SET plan_id=excluded.plan_id,"
                " assignment_id=excluded.assignment_id, accepted=excluded.accepted,"
                " reject_reason=excluded.reject_reason, operator_comment=excluded.operator_comment,"
                " predicted_json=excluded.predicted_json, actual_json=excluded.actual_json,"
                " created_at=excluded.created_at",
                (
                    feedback_id,
                    f.get("plan_id", ""),
                    f.get("assignment_id", ""),
                    int(bool(f.get("accepted", False))),
                    f.get("reject_reason", ""),
                    f.get("operator_comment", ""),
                    json.dumps(f.get("predicted", {}), ensure_ascii=False),
                    json.dumps(f.get("actual", {}), ensure_ascii=False),
                    _now(),
                ),
            )

    def list_schedule_feedback(self, plan_id=None):
        with self._lock:
            if plan_id is None:
                rows = self._db.execute("SELECT * FROM schedule_feedback ORDER BY id DESC").fetchall()
            else:
                rows = self._db.execute(
                    "SELECT * FROM schedule_feedback WHERE plan_id=? ORDER BY id DESC", (plan_id,)
                ).fetchall()
            out = []
            for r in rows:
                d = dict(r)
                d["predicted"] = json.loads(d.pop("predicted_json") or "{}")
                d["actual"] = json.loads(d.pop("actual_json") or "{}")
                d["accepted"] = bool(d.get("accepted"))
                out.append(d)
            return out

    def save_world_state_snapshot(self, snapshot_id, **s):
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO world_state_snapshot (snapshot_id, timestamp, persons_json, devices_json,"
                " tasks_json, stations_json, assignments_json, reservations_json, events_json,"
                " topology_version, metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(snapshot_id) DO UPDATE SET timestamp=excluded.timestamp,"
                " persons_json=excluded.persons_json, devices_json=excluded.devices_json,"
                " tasks_json=excluded.tasks_json, stations_json=excluded.stations_json,"
                " assignments_json=excluded.assignments_json, reservations_json=excluded.reservations_json,"
                " events_json=excluded.events_json, topology_version=excluded.topology_version,"
                " metadata_json=excluded.metadata_json",
                (
                    snapshot_id,
                    s.get("timestamp", ""),
                    json.dumps(s.get("persons", []), ensure_ascii=False),
                    json.dumps(s.get("devices", []), ensure_ascii=False),
                    json.dumps(s.get("tasks", []), ensure_ascii=False),
                    json.dumps(s.get("stations", []), ensure_ascii=False),
                    json.dumps(s.get("assignments", []), ensure_ascii=False),
                    json.dumps(s.get("reservations", []), ensure_ascii=False),
                    json.dumps(s.get("events", []), ensure_ascii=False),
                    s.get("topology_version", ""),
                    json.dumps(
                        {"version": 1, "source_timestamps": s.get("source_timestamps") or {}}, ensure_ascii=False,
                    ),
                ),
            )

    def get_world_state_snapshot(self, snapshot_id):
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM world_state_snapshot WHERE snapshot_id=?", (snapshot_id,)
            ).fetchone()
            return self._snapshot_row(row)

    def list_world_state_snapshots(self, limit=20):
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM world_state_snapshot ORDER BY id DESC LIMIT ?", (int(limit),)
            ).fetchall()
            return [self._snapshot_row(r) for r in rows]

    @staticmethod
    def _snapshot_row(row):
        if not row:
            return None
        d = dict(row)
        for k in ("persons_json", "devices_json", "tasks_json", "stations_json", "assignments_json",
                  "reservations_json", "events_json"):
            d[k.replace("_json", "")] = json.loads(d.pop(k) or "[]")
        metadata = json.loads(d.pop("metadata_json") or "{}")
        if metadata and metadata.get("version") != 1:
            raise ValueError("Unsupported world state snapshot metadata version")
        d["source_timestamps"] = metadata.get("source_timestamps", {})
        return d

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
