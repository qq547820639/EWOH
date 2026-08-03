"""分层保留策略：高频遥测 / 分钟聚合 / 事件证据 / 调度任务 / 审计日志 / 三维底图 / 训练数据。

对应 spec「数据治理与隐私扩展」分层保留（spec 8.3）：
- 高频原始遥测 7—30 天（取 30）；
- 分钟级聚合 6—12 个月（取 365，即 12 个月）；
- 事件证据按事件闭环周期（取 90 天）；
- 调度与任务记录按生产审计周期（取 365 天）；
- 审计日志不少于 180 天（取 180）；
- 三维底图按版本长期保存（-1，不自动删除，版本化管理）；
- 模型训练数据单独授权和版本管理（-1，不自动删除）。

策略版本化注册：新版本不覆盖旧版本，保留历史（spec「三维底图按版本长期保存/训练数据单独
授权和版本管理」）。purge_due 永不清理 SPATIAL_BASEMAP / TRAINING_DATA，且 AUDIT_LOG
未满 180 天不清理（即便策略被改小也不得提前清理）。

纯 Python 标准库实现；沿用 edge_platform.spatial 的 new_id / now_iso 与
edge_platform.inference 的 ts_to_ms 约定。
"""

import enum
from dataclasses import dataclass

from edge_platform.inference import ts_to_ms
from edge_platform.spatial import new_id, now_iso

_MS_PER_DAY = 86400 * 1000


class DataClass(enum.Enum):
    """数据分级（spec 8.3 分层保留）。"""

    HIGH_FREQ_TELEMETRY = "HIGH_FREQ_TELEMETRY"  # 高频原始遥测 7—30 天
    MINUTE_AGG = "MINUTE_AGG"  # 分钟级聚合 6—12 月
    EVENT_EVIDENCE = "EVENT_EVIDENCE"  # 事件证据（事件闭环周期）
    SCHEDULE_TASK = "SCHEDULE_TASK"  # 调度与任务记录（生产审计周期）
    AUDIT_LOG = "AUDIT_LOG"  # 审计日志 >=180 天
    SPATIAL_BASEMAP = "SPATIAL_BASEMAP"  # 三维底图按版本长期
    TRAINING_DATA = "TRAINING_DATA"  # 训练数据单独授权版本管理


# 默认保留天数（spec 8.3）；-1 表示长期保留/版本化，不自动删除
DEFAULT_RETENTION = {
    DataClass.HIGH_FREQ_TELEMETRY: 30,
    DataClass.MINUTE_AGG: 365,
    DataClass.EVENT_EVIDENCE: 90,
    DataClass.SCHEDULE_TASK: 365,
    DataClass.AUDIT_LOG: 180,
    DataClass.SPATIAL_BASEMAP: -1,
    DataClass.TRAINING_DATA: -1,
}

# 审计日志最低保留天数（spec「审计日志不少于 180 天」，即便策略更小也不得提前清理）
_AUDIT_LOG_MIN_DAYS = 180

# 永不自动清除的数据分级（长期/版本化）
_NEVER_PURGE = frozenset({DataClass.SPATIAL_BASEMAP, DataClass.TRAINING_DATA})


@dataclass
class RetentionPolicy:
    """保留策略：某数据分级的保留天数与版本。

    retention_days: -1 表示长期保留/版本化，不自动删除；
    version: 策略版本（注册时由 RetentionManager 自动递增）；
    effective_from: 生效时间。
    """

    data_class: DataClass
    retention_days: int
    policy_id: str = ""
    version: int = 1
    effective_from: str = ""
    note: str = ""

    def __post_init__(self):
        if isinstance(self.data_class, str):
            self.data_class = DataClass(self.data_class)
        if not self.policy_id:
            self.policy_id = new_id("RET")
        if not self.effective_from:
            self.effective_from = now_iso()

    def to_dict(self):
        return {
            "policy_id": self.policy_id,
            "data_class": self.data_class.value,
            "retention_days": self.retention_days,
            "version": self.version,
            "effective_from": self.effective_from,
            "note": self.note,
        }


class RetentionManager:
    """保留策略管理器：版本化注册、当前策略查询、过期判定与到期清理。

    - register：版本化注册，新版本不覆盖旧版本，保留历史；
    - current：返回某数据分级的当前（最新）策略，未注册返回 None；
    - expire_by：计算某记录的过期时间戳（record_ts + retention_days），-1 返回 None；
    - purge_due：返回已过保留期的记录列表（供清理作业处理）。
      永不清理 SPATIAL_BASEMAP / TRAINING_DATA；AUDIT_LOG 未满 180 天不清理。
    """

    def __init__(self):
        # data_class -> list[RetentionPolicy]（按注册顺序，最新在尾）
        self._history: dict[DataClass, list[RetentionPolicy]] = {}

    @staticmethod
    def _dc(data_class):
        return data_class if isinstance(data_class, DataClass) else DataClass(data_class)

    def register(self, policy):
        """注册保留策略；同一 data_class 的历史版本保留，新版本不覆盖旧版本。

        version 由管理器自动递增（取当前最大版本 + 1）。
        """
        if not isinstance(policy, RetentionPolicy):
            raise TypeError("只接受 RetentionPolicy 实例")
        dc = policy.data_class
        history = self._history.setdefault(dc, [])
        if history:
            policy.version = max(p.version for p in history) + 1
        else:
            policy.version = max(1, policy.version)
        history.append(policy)
        return policy

    def current(self, data_class):
        """返回某数据分级的当前（最新）策略；未注册返回 None。"""
        history = self._history.get(self._dc(data_class))
        return history[-1] if history else None

    def history(self, data_class):
        """返回某数据分级的全部版本历史（按注册顺序）。"""
        return list(self._history.get(self._dc(data_class), []))

    def _retention_days(self, data_class):
        """取生效保留天数：优先已注册策略，否则 DEFAULT_RETENTION。"""
        dc = self._dc(data_class)
        policy = self.current(dc)
        if policy is not None:
            return policy.retention_days
        return DEFAULT_RETENTION[dc]

    def expire_by(self, data_class, record_ts):
        """计算某记录的过期时间戳（Unix 毫秒）。

        返回 record_ts + retention_days（毫秒）；retention_days=-1 返回 None（永不过期）。
        """
        dc = self._dc(data_class)
        days = self._retention_days(dc)
        if days is None or days < 0:
            return None
        return ts_to_ms(record_ts) + days * _MS_PER_DAY

    def purge_due(self, records):
        """返回已过保留期的记录列表（供清理作业处理）。

        records: [{"data_class", "record_ts", "record_id"}]
        永不清理 SPATIAL_BASEMAP / TRAINING_DATA；AUDIT_LOG 至少保留 180 天
        （即便策略被改小也不得提前清理）。
        """
        now_ms = ts_to_ms(now_iso())
        due = []
        for r in records:
            dc = self._dc(r["data_class"])
            # 永不自动清除的分级直接跳过
            if dc in _NEVER_PURGE:
                continue
            record_ms = ts_to_ms(r["record_ts"])
            if dc is DataClass.AUDIT_LOG:
                # 审计日志最低保留 180 天（不得提前清理）
                expire_ms = record_ms + _AUDIT_LOG_MIN_DAYS * _MS_PER_DAY
            else:
                days = self._retention_days(dc)
                if days is None or days < 0:
                    continue
                expire_ms = record_ms + days * _MS_PER_DAY
            if expire_ms <= now_ms:
                due.append(r)
        return due
