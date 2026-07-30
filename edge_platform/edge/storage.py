"""EWOH 平台持久层（SQLite，真实实现）。

对齐 edge_platform/stubs.py 的 Storage 全部方法签名（保证 server.py/services.py
在 real/stub 间无缝切换），并扩展 Task 9 新增能力：
- telemetry 表新增 device_model/firmware_version/protocol_version/raw_ref 列
- raw_frame 表（原始帧字节留存，可追溯到线协议字节）
- audit_log 表（适配层操作审计：IDENT/FAULT 等关键事件）
- consent_record 表（人员授权记录）
- insert_raw_frame / mark_offline / insert_audit / list_audit 等新方法

阶段 2（Task 14/15/17）扩展：
- 新增表：device_protocol_version / event_handling / assignment / model_registry /
  rule_registry / consent_record（对齐 spec）/ schema_migrations
- 新增能力：apply_migrations / backup_db / restore_db / retention_purge /
  withdraw_consent / 模型&规则注册表 CRUD / slow_query_log / db_size_bytes / table_counts
- Postgres 后端占位：EWOH_DB_BACKEND=postgres + EWOH_DB_URL 时尝试 psycopg2，
  不可用则抛清晰错误（不强制依赖）。SQLite 路径为默认且完整可用。

线程安全（threading.Lock + check_same_thread=False）。
"""
import json
import os
import shutil
import sqlite3
import threading
import uuid
from datetime import datetime, timedelta

_SCHEMA = """
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
CREATE TABLE IF NOT EXISTS raw_frame (
  record_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, ts TEXT NOT NULL, seq INTEGER,
  frame_type INTEGER, raw_bytes BLOB, source_type TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_raw_frame_device_ts ON raw_frame(device_id, ts);
CREATE TABLE IF NOT EXISTS audit_log (
  audit_id TEXT PRIMARY KEY, actor TEXT, action TEXT NOT NULL,
  object_type TEXT, object_id TEXT,
  before_json TEXT, after_json TEXT, ts TEXT NOT NULL,
  request_id TEXT, source_ip TEXT, result TEXT NOT NULL DEFAULT 'ok');
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE TABLE IF NOT EXISTS consent_record (
  consent_id TEXT PRIMARY KEY, person_id TEXT, granted_at TEXT,
  withdrawn_at TEXT, scope TEXT, source TEXT);
CREATE INDEX IF NOT EXISTS idx_consent_record_person ON consent_record(person_id);
-- 阶段 2：设备协议版本注册表（按 device_model 维度记录可用协议/固件区间）
CREATE TABLE IF NOT EXISTS device_protocol_version (
  device_model TEXT PRIMARY KEY, protocol_version TEXT NOT NULL,
  firmware_min TEXT, firmware_max TEXT, notes TEXT, created_at TEXT NOT NULL);
-- 阶段 2：事件处置流水（评论/状态变更/确认等动作的留痕，与 risk_event 多对一）
CREATE TABLE IF NOT EXISTS event_handling (
  handling_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, action TEXT NOT NULL,
  operator TEXT, handled_at TEXT NOT NULL, comment_json TEXT);
CREATE INDEX IF NOT EXISTS idx_event_handling_event ON event_handling(event_id);
-- 阶段 2：人工确认派工流水（与 ctx.assignments 等价，持久化后可在重启后恢复）
CREATE TABLE IF NOT EXISTS assignment (
  task_id TEXT NOT NULL, person_id TEXT NOT NULL, confirmer TEXT,
  status TEXT NOT NULL, confirmed_at TEXT NOT NULL,
  PRIMARY KEY (task_id, person_id));
-- 阶段 2：模型注册表（model_id + version 双主键，激活态互斥）
CREATE TABLE IF NOT EXISTS model_registry (
  model_id TEXT NOT NULL, version TEXT NOT NULL, path TEXT,
  activated_at TEXT, is_active INTEGER NOT NULL DEFAULT 0,
  metrics_json TEXT, card_path TEXT,
  PRIMARY KEY (model_id, version));
-- 阶段 2：规则注册表
CREATE TABLE IF NOT EXISTS rule_registry (
  rule_id TEXT NOT NULL, version TEXT NOT NULL, config_json TEXT,
  activated_by TEXT, activated_at TEXT, is_active INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (rule_id, version));
-- 阶段 2：迁移版本表（apply_migrations 记录已执行版本，幂等保护）
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
"""

# telemetry / device 表需迁移新增的列（列名 -> DDL）
_TELEMETRY_NEW_COLUMNS = {
    "device_model": "TEXT",
    "firmware_version": "TEXT",
    "protocol_version": "TEXT",
    "raw_ref": "TEXT",
}
_DEVICE_NEW_COLUMNS = {
    "device_model": "TEXT",
    "protocol_version": "TEXT",
}


def _now():
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


class StorageBackendUnavailable(RuntimeError):
    """请求的后端不可用（如选 postgres 但未安装 psycopg2）。"""


def create_storage(db_path=None):
    """工厂：按 EWOH_DB_BACKEND 选择 sqlite（默认）或 postgres 后端。

    - EWOH_DB_BACKEND=sqlite 或未设置：使用 sqlite3 标准库（默认）
    - EWOH_DB_BACKEND=postgres + EWOH_DB_URL：尝试 psycopg2，不可用则抛
      StorageBackendUnavailable 并提示安装/回退 sqlite。

    返回的 Storage 实例统一暴露相同方法签名（postgres 当前为占位实现，
    后续阶段补齐后可无缝替换）。
    """
    backend = (os.environ.get("EWOH_DB_BACKEND") or "sqlite").strip().lower()
    if backend == "postgres":
        url = os.environ.get("EWOH_DB_URL")
        if not url:
            raise StorageBackendUnavailable(
                "EWOH_DB_BACKEND=postgres 需同时提供 EWOH_DB_URL，请配置后重试或回退 sqlite。")
        try:
            import psycopg2  # noqa: F401  可选依赖，仅占位
        except ImportError as e:
            raise StorageBackendUnavailable(
                "Postgres 后端需要 psycopg2，未安装： %s。请执行 `pip install psycopg2-binary` "
                "或回退 EWOH_DB_BACKEND=sqlite。当前 SQLite 路径完整可用。" % e) from e
        # 阶段 2 仅占位：真实 postgres 适配在后续阶段补齐
        raise StorageBackendUnavailable(
            "Postgres 适配器尚未实现（阶段 2 仅占位）。当前请使用 EWOH_DB_BACKEND=sqlite。")
    return Storage(db_path or ":memory:")


class Storage:
    """SQLite 持久层（对齐 stubs.Storage 签名 + Task 9 扩展 + 阶段 2 扩展）。"""

    backend = "sqlite"

    def __init__(self, db_path):
        self.db_path = str(db_path)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.db_path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._slow_queries = []   # 慢查询记录（in-memory，仅工程观测用）
        self.init_db()

    def init_db(self):
        """建表 + 迁移（CREATE TABLE IF NOT EXISTS + 检查列再 ALTER ADD COLUMN）。"""
        with self._lock, self._db:
            self._db.executescript(_SCHEMA)
            self._migrate_columns("telemetry", _TELEMETRY_NEW_COLUMNS)
            self._migrate_columns("device", _DEVICE_NEW_COLUMNS)

    def _migrate_columns(self, table, columns):
        existing = {row["name"] for row in self._db.execute(
            "PRAGMA table_info(%s)" % table).fetchall()}
        for col, ddl in columns.items():
            if col not in existing:
                self._db.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, col, ddl))

    def close(self):
        # 必须先取锁：避免与并发写线程（如 adapter 的 _on_disconnect->mark_offline）
        # 竞争——若 close() 在 SQL 语句执行期间关闭连接，sqlite3 C 扩展会段错误。
        # 取锁可保证任何持锁的写操作（insert_telemetry/mark_offline/...）完成后
        # 才关闭连接。
        with self._lock:
            try:
                self._db.close()
            except Exception:
                pass

    # ---- 原始帧（Task 9） ----
    def insert_raw_frame(self, device_id, ts, seq, frame_type, raw_bytes, source_type):
        """插入原始帧记录，返回 record_id。"""
        record_id = uuid.uuid4().hex
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO raw_frame (record_id, device_id, ts, seq, frame_type, raw_bytes, source_type) "
                "VALUES (?,?,?,?,?,?,?)",
                (record_id, device_id, ts, int(seq or 0), int(frame_type or 0),
                 sqlite3.Binary(bytes(raw_bytes or b"")), source_type))
        return record_id

    # ---- 遥测 ----
    def insert_telemetry(self, msg):
        """插入标准消息（含 Task 9 扩展字段）。"""
        quality = msg.get("quality") or {}
        with self._lock, self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO telemetry "
                "(record_id, device_id, ts, seq, payload_json, quality_status, source_type, "
                " device_model, firmware_version, protocol_version, raw_ref) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (msg["record_id"], msg["device_id"], msg["timestamp"],
                 msg.get("sequence", 0),
                 json.dumps(msg.get("telemetry", {}), ensure_ascii=False),
                 quality.get("status", "good"), msg["source_type"],
                 msg.get("device_model"), msg.get("firmware_version"),
                 msg.get("protocol_version"), msg.get("raw_ref")))
            self._db.execute(
                "UPDATE device SET last_seen=?, online=1 WHERE device_id=?",
                (msg["timestamp"], msg["device_id"]))

    def latest_telemetry(self, device_id):
        row = self._db.execute(
            "SELECT * FROM telemetry WHERE device_id=? ORDER BY ts DESC LIMIT 1",
            (device_id,)).fetchone()
        return self._tele_row(row)

    def query_telemetry(self, device_id, start, end, limit):
        rows = self._db.execute(
            "SELECT * FROM telemetry WHERE device_id=? AND ts BETWEEN ? AND ? "
            "ORDER BY ts LIMIT ?", (device_id, start, end, int(limit))).fetchall()
        return [self._tele_row(r) for r in rows]

    def has_telemetry_seq(self, device_id, seq):
        """检查指定 (device_id, seq) 的遥测是否已存在（补传去重用）。

        按 SEQ 跨连接去重：设备断线重连后补传的 SEQ，若已存在于实时流或更早的
        补传中，则跳过，避免重复入库（对齐 spec §3.5「补传数据按 SEQ 去重」）。
        """
        if seq is None:
            return False
        row = self._db.execute(
            "SELECT 1 FROM telemetry WHERE device_id=? AND seq=? LIMIT 1",
            (device_id, int(seq))).fetchone()
        return row is not None

    def export_slice(self, device_id, start, end):
        records = self.query_telemetry(device_id, start, end, 100000)
        return {"device_id": device_id, "start": start, "end": end,
                "record_count": len(records), "records": records,
                "source_type": records[0]["source_type"] if records else None}

    @staticmethod
    def _tele_row(row):
        if not row:
            return None
        d = {"record_id": row["record_id"], "device_id": row["device_id"],
             "timestamp": row["ts"], "sequence": row["seq"],
             "telemetry": json.loads(row["payload_json"]),
             "quality": {"status": row["quality_status"]}, "source_type": row["source_type"]}
        # 透传 Task 9 扩展字段（若列存在且非 None）
        for k in ("device_model", "firmware_version", "protocol_version", "raw_ref"):
            try:
                v = row[k]
            except (IndexError, KeyError):
                v = None
            if v is not None:
                d[k] = v
        return d

    def get_raw_frame(self, record_id):
        """读取原始帧记录（含 raw_bytes BLOB）。"""
        row = self._db.execute("SELECT * FROM raw_frame WHERE record_id=?",
                               (record_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        d["raw_bytes"] = bytes(d["raw_bytes"]) if d.get("raw_bytes") else b""
        return d

    # ---- 设备 / 人员 ----
    def list_devices(self):
        return [dict(r) for r in self._db.execute("SELECT * FROM device").fetchall()]

    def list_people(self):
        return [dict(r) for r in self._db.execute("SELECT * FROM person").fetchall()]

    def upsert_device(self, **d):
        """upsert 设备（支持 device_model/protocol_version 扩展字段）。"""
        with self._lock, self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO device "
                "(device_id, device_type, model, firmware_version, person_id, online, "
                " source_type, last_seen, device_model, protocol_version) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (d["device_id"], d.get("device_type", "exoskeleton"), d.get("model", ""),
                 d.get("firmware_version"), d.get("person_id"), int(d.get("online", 0)),
                 d["source_type"], d.get("last_seen"),
                 d.get("device_model"), d.get("protocol_version")))

    def upsert_person(self, **p):
        with self._lock, self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO person "
                "(person_id, display_name, team, skills_json, consent_status, active) "
                "VALUES (?,?,?,?,?,?)",
                (p["person_id"], p["display_name"], p.get("team"),
                 json.dumps(p.get("skills", []), ensure_ascii=False),
                 p.get("consent_status", "granted"), int(p.get("active", 1))))

    def mark_offline(self, device_id, ts):
        """标记设备离线。"""
        with self._lock, self._db:
            self._db.execute("UPDATE device SET online=0, last_seen=? WHERE device_id=?",
                             (ts, device_id))

    def register_device(self, device_id, device_type="exoskeleton", model="",
                        firmware_version=None, source_type="real", **extra):
        """注册设备（便捷封装，供 manager/测试调用）。"""
        self.upsert_device(device_id=device_id, device_type=device_type, model=model,
                           firmware_version=firmware_version, source_type=source_type, **extra)

    # ---- 推理 ----
    def insert_inference(self, res):
        with self._lock, self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO inference VALUES (?,?,?,?,?,?,?,?,?,?)",
                (res["inference_id"], res["device_id"], res["ts_start"], res["ts_end"],
                 res["label"], res.get("confidence"), res.get("model_id"),
                 res.get("model_version"),
                 json.dumps(res.get("meta") or res.get("evidence") or {}, ensure_ascii=False),
                 res["source_type"]))

    def query_inference(self, device_id, start, end, limit):
        rows = self._db.execute(
            "SELECT * FROM inference WHERE device_id=? AND ts_end BETWEEN ? AND ? "
            "ORDER BY ts_end LIMIT ?", (device_id, start, end, int(limit))).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["meta"] = json.loads(d.pop("evidence_json") or "{}")
            out.append(d)
        return out

    # ---- 事件 ----
    def insert_event(self, evt):
        with self._lock, self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO risk_event VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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

    # ---- 审计日志（Task 9） ----
    def insert_audit(self, actor, action, object_type, object_id,
                     before_json=None, after_json=None, source_ip=None,
                     request_id=None, result="ok"):
        audit_id = uuid.uuid4().hex
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO audit_log "
                "(audit_id, actor, action, object_type, object_id, before_json, after_json, "
                " ts, request_id, source_ip, result) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (audit_id, actor, action, object_type, object_id,
                 json.dumps(before_json, ensure_ascii=False) if before_json is not None else None,
                 json.dumps(after_json, ensure_ascii=False) if after_json is not None else None,
                 _now(), request_id, source_ip, result))
        return audit_id

    def list_audit(self, limit=100, action=None, actor=None, object_type=None):
        """审计查询：支持按 action / actor / object_type 过滤，按 ts 倒序。"""
        sql = "SELECT * FROM audit_log"
        clauses, params = [], []
        if action:
            clauses.append("action=?"); params.append(action)
        if actor:
            clauses.append("actor=?"); params.append(actor)
        if object_type:
            clauses.append("object_type=?"); params.append(object_type)
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY ts DESC LIMIT ?"
        params.append(int(limit))
        rows = self._db.execute(sql, params).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["before"] = json.loads(d.pop("before_json") or "null")
            d["after"] = json.loads(d.pop("after_json") or "null")
            out.append(d)
        return out

    # ---- 统计 / 重置 ----
    def counts(self):
        def n(t):
            return self._db.execute("SELECT COUNT(*) c FROM %s" % t).fetchone()["c"]
        return {"person": n("person"), "device": n("device"), "telemetry": n("telemetry"),
                "inference": n("inference"), "risk_event": n("risk_event"),
                "raw_frame": n("raw_frame"), "audit_log": n("audit_log")}

    def reset_demo(self):
        """演示重置：清空非 real 来源数据与设备在线状态（真实数据保留）。

        audit_log 不含 source_type 列（审计记录为操作日志，不区分数据来源，予以保留）；
        仅清理 telemetry/inference/risk_event/raw_frame 中非 real 来源记录。
        """
        with self._lock, self._db:
            for t in ("telemetry", "inference", "risk_event", "raw_frame"):
                self._db.execute("DELETE FROM %s WHERE source_type!='real'" % t)
            self._db.execute("UPDATE device SET online=0 WHERE source_type!='real'")

    # ============================================================
    # 阶段 2：迁移 / 备份 / 恢复 / 保留 / 容量监控
    # ============================================================

    def apply_migrations(self, migrations_dir):
        """按序读取并执行 migrations/*.sql，记录已执行版本到 schema_migrations。

        幂等：已在 schema_migrations 中的版本跳过。文件名约定 `<序号>_<名称>.sql`，
        序号作为 version 主键。

        返回 dict {applied:[...], skipped:[...]}：
          - applied：本次成功执行的版本（已写入 schema_migrations）
          - skipped：执行失败（脚本不兼容当前后端，如 SQLite 不支持
            `ALTER TABLE ADD COLUMN IF NOT EXISTS`）。SQLite 路径下这些列
            迁移已由 `_migrate_columns()` 在 init_db 阶段处理；postgres
            上脚本可正常执行。

        单个脚本失败时不中断后续脚本执行，便于运维按需补齐。
        """
        from pathlib import Path
        mdir = Path(migrations_dir)
        if not mdir.is_dir():
            return {"applied": [], "skipped": []}
        files = sorted(f for f in mdir.glob("*.sql"))
        applied, skipped = [], []
        with self._lock, self._db:
            for f in files:
                version = f.stem  # e.g. "001_initial"
                done = self._db.execute(
                    "SELECT 1 FROM schema_migrations WHERE version=?", (version,)).fetchone()
                if done:
                    continue
                sql = f.read_text(encoding="utf-8")
                try:
                    # executescript 自动提交且支持多语句
                    self._db.executescript(sql)
                except sqlite3.Error as e:
                    # 不兼容语法（如 SQLite ADD COLUMN IF NOT EXISTS）跳过；
                    # 不写入 schema_migrations，便于切换兼容后端后重试。
                    skipped.append({"version": version, "error": str(e)})
                    continue
                self._db.execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (?,?)",
                    (version, _now()))
                applied.append(version)
        return {"applied": applied, "skipped": skipped}

    def backup_db(self, dest_path):
        """SQLite 文件复制备份（shutil.copy2，保留元数据）。

        Postgres 占位：阶段 2 暂未实现 pg_dump 调用，返回 NotImplemented 标记。
        """
        if self.backend != "sqlite":
            # 占位：正式 postgres 适配在后续阶段补 pg_dump 调用
            raise NotImplementedError("postgres backup_db 尚未实现（阶段 2 占位）")
        from pathlib import Path
        dest = Path(dest_path)
        dest.parent.mkdir(parents=True, exist_ok=True)
        # 先 flush WAL，确保一致性
        with self._lock:
            try:
                self._db.execute("PRAGMA wal_checkpoint(FULL)")
            except Exception:
                pass
        shutil.copy2(self.db_path, str(dest))
        return str(dest)

    def restore_db(self, src_path):
        """恢复：关闭连接 → 复制 src 到 db_path → 重开连接 → init_db。

        仅 SQLite 路径支持；postgres 恢复需走 pg_restore（占位）。
        """
        if self.backend != "sqlite":
            raise NotImplementedError("postgres restore_db 尚未实现（阶段 2 占位）")
        with self._lock:
            try:
                self._db.close()
            except Exception:
                pass
            shutil.copy2(str(src_path), self.db_path)
            self._db = sqlite3.connect(self.db_path, check_same_thread=False)
            self._db.row_factory = sqlite3.Row
        self.init_db()

    def retention_purge(self, retention_days, person_id=None):
        """删除早于 now - retention_days 的高频遥测与推理记录，保留事件与审计。

        - 默认删除 telemetry / inference 中 ts 早于阈值的记录（按 source_type
          可分别清理 real/controlled_test/simulated 的高频数据）
        - 当 person_id 提供时：按设备绑定的 person_id 过滤，专门用于授权撤回场景
          （撤回后停止采集并删除该人员的历史 telemetry / inference；
          risk_event 与 audit_log 仍保留——审计与事件留痕是合规底线）。

        返回各表删除条数 dict。
        """
        cutoff = (datetime.now().astimezone() - timedelta(days=int(retention_days))).isoformat(
            timespec="milliseconds")
        deleted = {"telemetry": 0, "inference": 0}
        with self._lock, self._db:
            if person_id:
                # 按 person 维度清理：通过 device.person_id 关联
                dev_ids = [r["device_id"] for r in self._db.execute(
                    "SELECT device_id FROM device WHERE person_id=?", (person_id,)).fetchall()]
                if dev_ids:
                    placeholders = ",".join("?" * len(dev_ids))
                    deleted["telemetry"] = self._db.execute(
                        "DELETE FROM telemetry WHERE device_id IN (%s)" % placeholders,
                        dev_ids).rowcount
                    deleted["inference"] = self._db.execute(
                        "DELETE FROM inference WHERE device_id IN (%s)" % placeholders,
                        dev_ids).rowcount
            else:
                deleted["telemetry"] = self._db.execute(
                    "DELETE FROM telemetry WHERE ts<?", (cutoff,)).rowcount
                deleted["inference"] = self._db.execute(
                    "DELETE FROM inference WHERE ts_end<?", (cutoff,)).rowcount
        return deleted

    # ---- 慢查询与容量监控 ----
    def slow_query_log(self, threshold_ms=100):
        """占位：返回当前 in-memory 累计的慢查询列表（实际采样靠装饰器/monkey patch
        在生产环境补齐）。本方法保留接口供监控仪表盘调用。

        threshold_ms 仅用于过滤返回值，不影响采集（采集点暂未植入）。
        """
        return [q for q in self._slow_queries if q.get("elapsed_ms", 0) >= threshold_ms]

    def db_size_bytes(self):
        """SQLite 数据库文件大小（字节）。"""
        if self.db_path == ":memory:":
            return 0
        try:
            return os.path.getsize(self.db_path)
        except OSError:
            return 0

    def table_counts(self):
        """所有业务表的行数概览（用于容量预警与日常巡检）。"""
        out = {}
        with self._lock:
            for t in ("person", "device", "telemetry", "inference", "risk_event",
                      "raw_frame", "audit_log", "consent_record",
                      "device_protocol_version", "event_handling", "assignment",
                      "model_registry", "rule_registry", "schema_migrations"):
                try:
                    out[t] = self._db.execute("SELECT COUNT(*) c FROM %s" % t).fetchone()["c"]
                except sqlite3.Error:
                    out[t] = None
        return out

    # ============================================================
    # 阶段 2：授权撤回（Task 15）
    # ============================================================
    def withdraw_consent(self, person_id, withdrawn_at, reason=None, scope=None,
                         source="admin", actor="admin"):
        """撤回授权：更新 person.consent_status='withdrawn'，写 consent_record，
        并审计。返回 consent_id。

        说明：本方法仅更新人员状态与授权记录；后续采集停止由 adapter/manager
        监听 person.consent_status 变化实现。历史 telemetry/inference 的删除
        由 retention_purge(person_id=...) 触发（调用方组合调用）。
        """
        consent_id = uuid.uuid4().hex
        with self._lock, self._db:
            self._db.execute(
                "UPDATE person SET consent_status='withdrawn' WHERE person_id=?",
                (person_id,))
            self._db.execute(
                "INSERT INTO consent_record "
                "(consent_id, person_id, granted_at, withdrawn_at, scope, source) "
                "VALUES (?,?,?,?,?,?)",
                (consent_id, person_id, None, withdrawn_at, scope, source))
        self.insert_audit(actor=actor, action="WITHDRAW_CONSENT",
                          object_type="person", object_id=person_id,
                          after_json={"reason": reason, "withdrawn_at": withdrawn_at,
                                      "scope": scope, "source": source})
        return consent_id

    def list_consent_records(self, person_id=None, limit=100):
        sql = "SELECT * FROM consent_record"
        clauses, params = [], []
        if person_id:
            clauses.append("person_id=?"); params.append(person_id)
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY withdrawn_at DESC NULLS LAST LIMIT ?"
        params.append(int(limit))
        return [dict(r) for r in self._db.execute(sql, params).fetchall()]

    # ============================================================
    # 阶段 2：设备协议版本注册表
    # ============================================================
    def upsert_device_protocol_version(self, device_model, protocol_version,
                                        firmware_min=None, firmware_max=None,
                                        notes=None):
        with self._lock, self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO device_protocol_version "
                "(device_model, protocol_version, firmware_min, firmware_max, notes, created_at) "
                "VALUES (?,?,?,?,?,?)",
                (device_model, protocol_version, firmware_min, firmware_max, notes, _now()))

    def list_device_protocol_versions(self):
        return [dict(r) for r in self._db.execute(
            "SELECT * FROM device_protocol_version ORDER BY device_model").fetchall()]

    # ============================================================
    # 阶段 2：事件处置流水（评论/状态变更留痕）
    # ============================================================
    def insert_event_handling(self, event_id, action, operator=None, comment=None,
                               handled_at=None):
        handling_id = uuid.uuid4().hex
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO event_handling "
                "(handling_id, event_id, action, operator, handled_at, comment_json) "
                "VALUES (?,?,?,?,?,?)",
                (handling_id, event_id, action, operator, handled_at or _now(),
                 json.dumps(comment, ensure_ascii=False) if comment is not None else None))
        return handling_id

    def list_event_handling(self, event_id):
        rows = self._db.execute(
            "SELECT * FROM event_handling WHERE event_id=? ORDER BY handled_at",
            (event_id,)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["comment"] = json.loads(d.pop("comment_json") or "null")
            out.append(d)
        return out

    # ============================================================
    # 阶段 2：人工确认派工流水（持久化版，可选启用）
    # ============================================================
    def upsert_assignment(self, task_id, person_id, confirmer=None, status="confirmed"):
        with self._lock, self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO assignment "
                "(task_id, person_id, confirmer, status, confirmed_at) VALUES (?,?,?,?,?)",
                (task_id, person_id, confirmer, status, _now()))

    def list_assignments(self):
        return [dict(r) for r in self._db.execute(
            "SELECT * FROM assignment ORDER BY confirmed_at DESC").fetchall()]

    # ============================================================
    # 阶段 2：模型注册表
    # ============================================================
    def upsert_model_registry(self, model_id, version, path=None, metrics=None,
                               card_path=None):
        with self._lock, self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO model_registry "
                "(model_id, version, path, activated_at, is_active, metrics_json, card_path) "
                "VALUES (?,?,?,?,?,?,?)",
                (model_id, version, path, _now(), 0,
                 json.dumps(metrics, ensure_ascii=False) if metrics is not None else None,
                 card_path))

    def list_models(self):
        rows = self._db.execute(
            "SELECT * FROM model_registry ORDER BY model_id, version").fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["metrics"] = json.loads(d.pop("metrics_json") or "null")
            d["is_active"] = bool(d.pop("is_active"))
            out.append(d)
        return out

    def activate_model(self, model_id, version, activated_by="admin"):
        """激活指定 (model_id, version)：同 model_id 其他版本置 0，目标置 1。"""
        with self._lock, self._db:
            self._db.execute(
                "UPDATE model_registry SET is_active=0 WHERE model_id=?", (model_id,))
            self._db.execute(
                "UPDATE model_registry SET is_active=1, activated_at=? "
                "WHERE model_id=? AND version=?",
                (_now(), model_id, version))
        self.insert_audit(actor=activated_by, action="ACTIVATE_MODEL",
                          object_type="model", object_id="%s@%s" % (model_id, version))

    # ============================================================
    # 阶段 2：规则注册表
    # ============================================================
    def upsert_rule_registry(self, rule_id, version, config=None, activated_by=None):
        with self._lock, self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO rule_registry "
                "(rule_id, version, config_json, activated_by, activated_at, is_active) "
                "VALUES (?,?,?,?,?,0)",
                (rule_id, version,
                 json.dumps(config, ensure_ascii=False) if config is not None else None,
                 activated_by, _now()))

    def list_rules(self):
        rows = self._db.execute(
            "SELECT * FROM rule_registry ORDER BY rule_id, version").fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["config"] = json.loads(d.pop("config_json") or "null")
            d["is_active"] = bool(d.pop("is_active"))
            out.append(d)
        return out

    def activate_rule(self, rule_id, version, activated_by="admin"):
        """激活指定规则版本：同 rule_id 其他版本置 0，目标置 1。"""
        with self._lock, self._db:
            self._db.execute(
                "UPDATE rule_registry SET is_active=0 WHERE rule_id=?", (rule_id,))
            self._db.execute(
                "UPDATE rule_registry SET is_active=1, activated_at=? "
                "WHERE rule_id=? AND version=?",
                (_now(), rule_id, version))
        self.insert_audit(actor=activated_by, action="ACTIVATE_RULE",
                          object_type="rule", object_id="%s@%s" % (rule_id, version))

    # ============================================================
    # 阶段 2：设备健康摘要辅助查询
    # ============================================================
    def get_device(self, device_id):
        row = self._db.execute("SELECT * FROM device WHERE device_id=?", (device_id,)).fetchone()
        return dict(row) if row else None

    def device_health(self, device_id):
        """设备健康摘要：online/last_packet_ts/packet_loss_pct/clock_offset_ms/
        battery/fault/reconnect_count。

        当前从最新遥测 payload 与 device 行推断；packet_loss_pct/clock_offset_ms/
        battery 等字段若遥测未携带则为 None。reconnect_count 暂以离线次数近似
        （阶段 2 不持久化会话级计数，后续阶段补 reconnect_event 表）。
        """
        dev = self.get_device(device_id)
        if not dev:
            return None
        latest = self.latest_telemetry(device_id)
        payload = (latest or {}).get("telemetry", {}) or {}
        quality = (latest or {}).get("quality", {}) or {}
        return {
            "device_id": device_id,
            "online": bool(dev.get("online")),
            "last_seen": dev.get("last_seen"),
            "last_packet_ts": (latest or {}).get("timestamp"),
            "packet_loss_pct": payload.get("packet_loss_pct") or quality.get("packet_loss_pct"),
            "clock_offset_ms": payload.get("clock_offset_ms"),
            "battery": payload.get("battery_percent") or payload.get("battery"),
            "fault": payload.get("fault") or quality.get("status") if quality.get("status") != "good" else None,
            "reconnect_count": None,  # 占位：后续补 reconnect_event 累计
            "source_type": dev.get("source_type"),
        }
