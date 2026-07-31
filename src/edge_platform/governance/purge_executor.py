"""数据保留清理执行器：按保留策略分批删除过期记录。

对应 spec Task 15「数据保留策略」的清理执行部分（策略与过期判定见 retention.py）：
- HIGH_FREQ_TELEMETRY：DELETE FROM telemetry WHERE ts < expire_ts（分批 batch_size）；
- MINUTE_AGG：DELETE FROM inference WHERE ts_end < expire_ts（降采样后删除原数据，
  此处简化为直接删除原推理记录）；
- EVENT_EVIDENCE：删除已关闭（status='closed'）且超过保留期的事件证据；
- AUDIT_LOG：强制至少 180 天（retention.py 已有此逻辑，执行器遵守，即便策略更小
  也不得提前清理）；
- SPATIAL_BASEMAP / TRAINING_DATA：永不清理（跳过）。

每次清理入审计日志（优先调用构造时传入的 audit_logger；否则写 storage.insert_audit_log）。
dry_run 仅返回待删除记录数，不实际删除。纯 Python 标准库实现。

沿用 edge_platform.governance.retention 的保留规则常量，保证执行器与 RetentionManager
的 purge_due 判定一致（永不清理分级 / AUDIT_LOG 180 天下限）。
"""

from typing import Callable, Optional

from edge_platform.governance.retention import (
    _AUDIT_LOG_MIN_DAYS,
    _MS_PER_DAY,
    _NEVER_PURGE,
    DEFAULT_RETENTION,
    DataClass,
    RetentionManager,
)
from edge_platform.inference import ms_to_ts, ts_to_ms
from edge_platform.spatial import now_iso


class PurgeExecutor:
    """数据保留清理执行器：按 RetentionManager 策略分批删除过期记录。

    retention_manager: 保留策略管理器（提供各分级的保留天数）；
    audit_logger: 可选审计回调 action/target_type/target_id/detail -> Any，
      未提供时回退到 storage.insert_audit_log。
    """

    def __init__(self, retention_manager: RetentionManager,
                 audit_logger: Optional[Callable] = None):
        self.rm = retention_manager
        self._audit_logger = audit_logger

    # ---- 工具 ----
    @staticmethod
    def _dc(data_class):
        return data_class if isinstance(data_class, DataClass) else DataClass(data_class)

    def _retention_days(self, dc):
        """取生效保留天数：优先已注册策略，否则 DEFAULT_RETENTION。"""
        policy = self.rm.current(dc)
        if policy is not None:
            return policy.retention_days
        return DEFAULT_RETENTION[dc]

    def _cutoff_ms(self, dc, now_ms):
        """计算过期截止时间戳（毫秒）：record_ts < cutoff 的记录应被清理。

        遵守 retention.purge_due 的规则：
        - SPATIAL_BASEMAP / TRAINING_DATA：返回 None（永不清理）；
        - retention_days < 0：返回 None（长期/版本化，不自动删除）；
        - AUDIT_LOG：强制至少 180 天（即便策略更小也不得提前清理）。
        """
        if dc in _NEVER_PURGE:
            return None
        days = self._retention_days(dc)
        if days is None or days < 0:
            return None
        if dc is DataClass.AUDIT_LOG:
            days = max(days, _AUDIT_LOG_MIN_DAYS)
        return now_ms - days * _MS_PER_DAY

    def _audit(self, storage, action, target_type, target_id, detail,
               before=None, after=None):
        """记录一条清理审计日志。"""
        if self._audit_logger is not None:
            return self._audit_logger(action, target_type, target_id, detail)
        if storage is not None and hasattr(storage, "insert_audit_log"):
            return storage.insert_audit_log(
                action, "system", target_type, target_id,
                before=before, after=after, result="success")
        return None

    @staticmethod
    def _batched_delete(storage, table, condition, params, batch_size):
        """按 batch_size 分批从 table 删除满足 condition 的记录，返回总删除条数。

        使用 rowid 子查询限制每批条数，避免一次性大事务。
        """
        deleted = 0
        subsql = f"SELECT rowid FROM {table} WHERE {condition} LIMIT ?"
        delsql = f"DELETE FROM {table} WHERE rowid IN ({subsql})"
        while True:
            with storage._lock, storage._db:
                cur = storage._db.execute(delsql, tuple(params) + (int(batch_size),))
                n = cur.rowcount
            deleted += n
            if n < batch_size:
                break
        return deleted

    # ---- dry_run ----
    def dry_run(self, storage, data_class) -> int:
        """返回待删除记录数（不实际删除）。"""
        dc = self._dc(data_class)
        cutoff_ms = self._cutoff_ms(dc, ts_to_ms(now_iso()))
        if cutoff_ms is None:
            return 0
        cutoff_ts = ms_to_ts(cutoff_ms)
        table_cond = self._table_condition(dc, cutoff_ts)
        if table_cond is None:
            return 0
        table, condition, params = table_cond
        sql = f"SELECT COUNT(*) c FROM {table} WHERE {condition}"
        row = storage._db.execute(sql, params).fetchone()
        return int(row["c"]) if row else 0

    def _table_condition(self, dc, cutoff_ts):
        """返回 (table, condition, params)；dc 无对应清理表时返回 None。

        EVENT_EVIDENCE 仅清理已关闭且超过保留期的事件证据（open 事件保留）。
        """
        if dc is DataClass.HIGH_FREQ_TELEMETRY:
            return "telemetry", "ts < ?", (cutoff_ts,)
        if dc is DataClass.MINUTE_AGG:
            return "inference", "ts_end < ?", (cutoff_ts,)
        if dc is DataClass.EVENT_EVIDENCE:
            return "risk_event", "status='closed' AND start_time < ?", (cutoff_ts,)
        if dc is DataClass.AUDIT_LOG:
            return "audit_log", "ts < ?", (cutoff_ts,)
        # SCHEDULE_TASK：本执行器未定义具体清理表（spec 未指定），按 0 计。
        return None

    # ---- purge_expired ----
    def purge_expired(self, storage, data_class, batch_size=1000) -> int:
        """分批删除过期记录，返回总删除条数。"""
        dc = self._dc(data_class)
        if dc in _NEVER_PURGE:
            # 三维底图 / 训练数据：永不清理
            return 0
        cutoff_ms = self._cutoff_ms(dc, ts_to_ms(now_iso()))
        if cutoff_ms is None:
            return 0
        cutoff_ts = ms_to_ts(cutoff_ms)
        table_cond = self._table_condition(dc, cutoff_ts)
        if table_cond is None:
            return 0
        table, condition, params = table_cond
        deleted = self._batched_delete(storage, table, condition, params, int(batch_size))
        if deleted > 0:
            self._audit(
                storage, "purge", "data_class", dc.value,
                f"deleted={deleted} cutoff={cutoff_ts}",
                before={"data_class": dc.value, "cutoff_ts": cutoff_ts, "table": table},
                after={"deleted": deleted})
        return deleted

    # ---- purge_all ----
    def purge_all(self, storage) -> dict[str, int]:
        """遍历所有 data_class 执行清理。返回 {data_class_value: deleted_count}。"""
        result = {}
        for dc in DataClass:
            result[dc.value] = self.purge_expired(storage, dc)
        return result
