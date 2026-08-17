"""受控采集会话与人工标签管理。

SessionManager(storage)：经 storage.db_path 在同一 SQLite 库中自建
collection_session / collection_label 两表（与 Storage 自有表解耦）。
会话字段覆盖：匿名人员/设备/固件/穿戴位置/松紧/动作/重复次数/负荷档位/
环境/地面/授权号/观察员/备注/主观反馈/异常。
"""

import json
import sqlite3
import time
from contextlib import closing

from edge_platform.inference import ms_to_ts, new_id, ts_to_ms_safe

# 允许通过 start_session(**fields) 覆盖的会话字段
SESSION_FIELDS = (
    "person_id",
    "device_id",
    "firmware_version",
    "wear_position",
    "wear_tightness",
    "action_code",
    "repetitions",
    "load_level",
    "environment",
    "ground",
    "consent_id",
    "observer",
    "notes",
    "subjective_feedback",
    "exception",
)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS collection_session (
  session_id TEXT PRIMARY KEY,
  start_ts TEXT NOT NULL,
  end_ts TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  person_id TEXT, device_id TEXT, firmware_version TEXT,
  wear_position TEXT, wear_tightness TEXT, action_code TEXT,
  repetitions INTEGER, load_level REAL,
  environment TEXT, ground TEXT,
  consent_id TEXT, observer TEXT, notes TEXT,
  subjective_feedback TEXT, exception TEXT,
  source_type TEXT NOT NULL DEFAULT 'controlled_test'
);
CREATE TABLE IF NOT EXISTS collection_label (
  label_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  action_code TEXT NOT NULL,
  start_ts TEXT NOT NULL,
  end_ts TEXT NOT NULL,
  labeler TEXT,
  quality TEXT,
  aux_tags TEXT
);
"""


class SessionManager:
    def __init__(self, storage):
        self.db_path = storage.db_path
        with closing(self._conn()) as c:
            c.executescript(_SCHEMA)

    def _conn(self):
        c = sqlite3.connect(self.db_path)
        c.row_factory = sqlite3.Row
        return c

    # ---- 会话 ----
    def _validate_consent(self, consent_id):
        """R2-EDM-06：受控采集会话涉及人体负荷/姿态/主观反馈等数据，授权号
        consent_id 缺失或无效一律 fail-closed 拒绝（ValueError），不再允许空。

        校验两级：
        1) 必须为非空非空白字符串（始终强制）；
        2) 若同库存在 governance 的 consent_record 表（生产 Storage 均建），
           进一步要求该 record_id 存在且 status='active'（已撤销/不存在即拒绝）。
        """
        if not isinstance(consent_id, str) or not consent_id.strip():
            raise ValueError(
                "受控采集会话必须携带非空 consent_id（人体数据采集强制关联授权，fail-closed）"
            )
        with closing(self._conn()) as c:
            has_table = c.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='consent_record'"
            ).fetchone()
            if has_table is None:
                # governance 体系未部署（无 consent_record 表）时保留非空强校验兜底
                return
            row = c.execute(
                "SELECT status FROM consent_record WHERE record_id=?", (consent_id,)
            ).fetchone()
        if row is None or row["status"] != "active":
            raise ValueError(f"consent_id 无效或授权非 active: {consent_id!r}")

    def start_session(self, **fields):
        """开启采集会话，返回 session_id；未知字段直接拒绝。

        R2-EDM-06：人体数据采集强制关联授权——consent_id 缺失/无效即拒绝（fail-closed）。
        """
        unknown = set(fields) - set(SESSION_FIELDS)
        if unknown:
            raise ValueError(f"未知会话字段: {sorted(unknown)}")
        self._validate_consent(fields.get("consent_id"))
        sid = new_id("SES")
        cols = ["session_id", "start_ts", "status"] + list(SESSION_FIELDS)
        vals = [sid, ms_to_ts(time.time() * 1000), "open"] + [fields.get(k) for k in SESSION_FIELDS]
        with closing(self._conn()) as c:
            c.execute(
                f"INSERT INTO collection_session ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",  # nosec B608 - fixed internal column names
                vals,
            )
            c.commit()
        return sid

    def stop_session(self, session_id):
        with closing(self._conn()) as c:
            cur = c.execute(
                "UPDATE collection_session SET status='closed', end_ts=? WHERE session_id=?",
                (ms_to_ts(time.time() * 1000), session_id),
            )
            c.commit()
        if cur.rowcount == 0:
            raise KeyError(f"会话不存在: {session_id}")

    def get_session(self, session_id):
        with closing(self._conn()) as c:
            row = c.execute("SELECT * FROM collection_session WHERE session_id=?", (session_id,)).fetchone()
            if row is None:
                return None
            sess = dict(row)
            sess["labels"] = [
                dict(r)
                for r in c.execute("SELECT * FROM collection_label WHERE session_id=? ORDER BY start_ts", (session_id,))
            ]
        for lb in sess["labels"]:
            lb["aux_tags"] = json.loads(lb["aux_tags"] or "[]")
        return sess

    def list_sessions(self):
        with closing(self._conn()) as c:
            return [dict(r) for r in c.execute("SELECT * FROM collection_session ORDER BY start_ts")]

    # ---- 标签 ----
    def add_label(
        self,
        session_id,
        action_code,
        start_ts,
        end_ts,
        labeler,
        quality,
        aux_tags,
        allow_closed=False,
    ):
        """给会话添加人工动作标签（起止时间为 ISO 字符串），返回 label_id。

        R2-EDM-05：标签直接作为 export_dataset 的开窗依据，故对时间戳做
        fail-closed 校验——非法/乱序/闭会话标签一律 ValueError 拒绝，防止
        反向/空窗样本静默污染训练数据：
        1) start_ts/end_ts 必须可解析为 ISO 时间；
        2) end_ts >= start_ts（乱序即拒绝）；
        3) 会话 status 必须为 open（closed 会话补标需显式 allow_closed=True）。
        """
        start_ms = ts_to_ms_safe(start_ts)
        end_ms = ts_to_ms_safe(end_ts)
        if start_ms is None or end_ms is None:
            raise ValueError(
                f"标签时间戳非法（须为 ISO 8601）: start_ts={start_ts!r}, end_ts={end_ts!r}"
            )
        if end_ms < start_ms:
            raise ValueError(
                f"标签时间次序非法（end_ts 早于 start_ts）: start_ts={start_ts!r}, end_ts={end_ts!r}"
            )
        lid = new_id("LBL")
        with closing(self._conn()) as c:
            row = c.execute(
                "SELECT status FROM collection_session WHERE session_id=?", (session_id,)
            ).fetchone()
            if row is None:
                raise KeyError(f"会话不存在: {session_id}")
            if row["status"] != "open" and not allow_closed:
                raise ValueError(
                    f"会话 {session_id} 已 {row['status']}，补标须显式 allow_closed=True（fail-closed）"
                )
            c.execute(
                "INSERT INTO collection_label"
                "(label_id,session_id,action_code,start_ts,end_ts,labeler,quality,aux_tags)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (
                    lid,
                    session_id,
                    action_code,
                    start_ts,
                    end_ts,
                    labeler,
                    quality,
                    json.dumps(list(aux_tags or []), ensure_ascii=False),
                ),
            )
            c.commit()
        return lid
