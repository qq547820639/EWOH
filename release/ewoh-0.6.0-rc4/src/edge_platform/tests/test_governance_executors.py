"""Task 15 数据保留清理执行器单元测试。

覆盖 PurgeExecutor：
- HIGH_FREQ_TELEMETRY / MINUTE_AGG / EVENT_EVIDENCE / AUDIT_LOG 分批删除过期记录；
- EVENT_EVIDENCE 仅清理已关闭且超期的事件（open 事件保留）；
- AUDIT_LOG 强制至少 180 天（即便策略更小也不得提前清理）；
- SPATIAL_BASEMAP / TRAINING_DATA 永不清理；
- dry_run 返回待删除数但不实际删除；
- purge_all 遍历所有 data_class；
- 每次清理入审计日志（storage.insert_audit_log 或自定义 audit_logger）；
- 分批 batch_size 生效；
- 自定义保留策略被遵守。

纯 Python 标准库 unittest；运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_governance_executors -v
"""

import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

# 支持 PYTHONPATH=src 与直接运行两种方式
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform import stubs
from edge_platform.governance import (
    DataClass,
    PurgeExecutor,
    RetentionManager,
    RetentionPolicy,
)


def _ts_days_ago(days):
    """返回 N 天前的 ISO 8601（毫秒精度，UTC）时间字符串。"""
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="milliseconds")


class _BasePurgeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ewoh_purge_")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.db_path = os.path.join(self.tmp, "purge.db")
        self.storage = stubs.Storage(self.db_path)
        self.rm = RetentionManager()
        self.executor = PurgeExecutor(self.rm)

    def tearDown(self):
        self.storage.close()

    # ---- 数据插入辅助 ----
    def _insert_telemetry(self, record_id, ts):
        self.storage.insert_telemetry(
            {
                "record_id": record_id,
                "device_id": "EXO-1",
                "timestamp": ts,
                "sequence": 0,
                "source_type": "simulated",
                "telemetry": {"pitch_deg": 10.0, "torque_nm": 5.0},
                "quality": {"status": "good"},
            }
        )

    def _insert_inference(self, inference_id, ts):
        self.storage.insert_inference(
            {
                "inference_id": inference_id,
                "device_id": "EXO-1",
                "ts_start": ts,
                "ts_end": ts,
                "label": "stand",
                "confidence": 0.9,
                "model_id": "m1",
                "model_version": "0.1",
                "source_type": "simulated",
                "meta": {},
            }
        )

    def _insert_event(self, event_id, ts, status="open"):
        self.storage.insert_event(
            {
                "event_id": event_id,
                "event_code": "LOAD_CONTINUOUS",
                "severity": "L2",
                "status": status,
                "person_id": "P-1",
                "device_id": "EXO-1",
                "start_time": ts,
                "trigger": {"type": "rule", "rule_version": "v1"},
                "evidence": {"window_before_sec": 30},
                "source_type": "simulated",
            }
        )

    def _insert_audit_log_raw(self, audit_id, ts):
        """直接写 audit_log 表（绕过 insert_audit_log 的 _now()），便于构造旧记录。"""
        with self.storage._lock, self.storage._db:
            self.storage._db.execute(
                "INSERT INTO audit_log (audit_id, action, actor_id, target_type, target_id, ts) VALUES (?,?,?,?,?,?)",
                (audit_id, "test", "u", "t", "1", ts),
            )


class HighFreqTelemetryPurgeTest(_BasePurgeTest):
    def test_purge_old_keeps_new(self):
        self._insert_telemetry("TS-OLD", _ts_days_ago(40))  # 过期（默认 30 天）
        self._insert_telemetry("TS-NEW", _ts_days_ago(10))  # 未过期
        deleted = self.executor.purge_expired(self.storage, DataClass.HIGH_FREQ_TELEMETRY)
        self.assertEqual(deleted, 1)
        remaining = [r["record_id"] for r in self.storage._db.execute("SELECT record_id FROM telemetry").fetchall()]
        self.assertNotIn("TS-OLD", remaining)
        self.assertIn("TS-NEW", remaining)

    def test_dry_run_does_not_delete(self):
        self._insert_telemetry("TS-OLD", _ts_days_ago(40))
        count = self.executor.dry_run(self.storage, DataClass.HIGH_FREQ_TELEMETRY)
        self.assertEqual(count, 1)
        # dry_run 后数据仍在
        remaining = [r["record_id"] for r in self.storage._db.execute("SELECT record_id FROM telemetry").fetchall()]
        self.assertIn("TS-OLD", remaining)

    def test_dry_run_zero_when_nothing_expired(self):
        self._insert_telemetry("TS-NEW", _ts_days_ago(10))
        count = self.executor.dry_run(self.storage, DataClass.HIGH_FREQ_TELEMETRY)
        self.assertEqual(count, 0)


class MinuteAggPurgeTest(_BasePurgeTest):
    def test_purge_old_inference(self):
        # MINUTE_AGG 默认 365 天
        self._insert_inference("INF-OLD", _ts_days_ago(400))  # 过期
        self._insert_inference("INF-NEW", _ts_days_ago(100))  # 未过期
        deleted = self.executor.purge_expired(self.storage, DataClass.MINUTE_AGG)
        self.assertEqual(deleted, 1)
        remaining = [
            r["inference_id"] for r in self.storage._db.execute("SELECT inference_id FROM inference").fetchall()
        ]
        self.assertNotIn("INF-OLD", remaining)
        self.assertIn("INF-NEW", remaining)


class EventEvidencePurgeTest(_BasePurgeTest):
    def test_only_closed_expired_purged(self):
        # 已关闭且超期 → 清理
        self._insert_event("EVT-CLOSED-OLD", _ts_days_ago(100), status="closed")
        # open 状态即使超期也保留
        self._insert_event("EVT-OPEN-OLD", _ts_days_ago(100), status="open")
        # 已关闭但未超期 → 保留
        self._insert_event("EVT-CLOSED-NEW", _ts_days_ago(10), status="closed")
        deleted = self.executor.purge_expired(self.storage, DataClass.EVENT_EVIDENCE)
        self.assertEqual(deleted, 1)
        remaining = [r["event_id"] for r in self.storage._db.execute("SELECT event_id FROM risk_event").fetchall()]
        self.assertNotIn("EVT-CLOSED-OLD", remaining)
        self.assertIn("EVT-OPEN-OLD", remaining)
        self.assertIn("EVT-CLOSED-NEW", remaining)

    def test_dry_run_counts_only_closed_expired(self):
        self._insert_event("EVT-CLOSED-OLD", _ts_days_ago(100), status="closed")
        self._insert_event("EVT-OPEN-OLD", _ts_days_ago(100), status="open")
        count = self.executor.dry_run(self.storage, DataClass.EVENT_EVIDENCE)
        self.assertEqual(count, 1)


class AuditLogPurgeTest(_BasePurgeTest):
    def test_audit_log_180_day_floor(self):
        # 200 天前 → 超过 180 天下限，应清理
        self._insert_audit_log_raw("AUD-OLD", _ts_days_ago(200))
        # 100 天前 → 未满 180 天，不应清理
        self._insert_audit_log_raw("AUD-YOUNG", _ts_days_ago(100))
        deleted = self.executor.purge_expired(self.storage, DataClass.AUDIT_LOG)
        self.assertEqual(deleted, 1)
        remaining = [
            r["audit_id"]
            for r in self.storage._db.execute("SELECT audit_id FROM audit_log WHERE action!='purge'").fetchall()
        ]
        self.assertNotIn("AUD-OLD", remaining)
        self.assertIn("AUD-YOUNG", remaining)

    def test_audit_log_floor_enforced_even_if_policy_smaller(self):
        # 注册一个 30 天的违规小策略，但 AUDIT_LOG 仍至少保留 180 天
        self.rm.register(RetentionPolicy(data_class=DataClass.AUDIT_LOG, retention_days=30, note="违规改小"))
        self._insert_audit_log_raw("AUD-100", _ts_days_ago(100))  # 100 天：30 天已过但 180 未满
        self._insert_audit_log_raw("AUD-200", _ts_days_ago(200))  # 200 天：超过 180
        deleted = self.executor.purge_expired(self.storage, DataClass.AUDIT_LOG)
        self.assertEqual(deleted, 1)
        remaining = [
            r["audit_id"]
            for r in self.storage._db.execute("SELECT audit_id FROM audit_log WHERE action!='purge'").fetchall()
        ]
        self.assertIn("AUD-100", remaining)
        self.assertNotIn("AUD-200", remaining)


class NeverPurgeTest(_BasePurgeTest):
    def test_spatial_basemap_skipped(self):
        # SPATIAL_BASEMAP 永不清理（即使有数据也返回 0）
        deleted = self.executor.purge_expired(self.storage, DataClass.SPATIAL_BASEMAP)
        self.assertEqual(deleted, 0)
        self.assertEqual(self.executor.dry_run(self.storage, DataClass.SPATIAL_BASEMAP), 0)

    def test_training_data_skipped(self):
        deleted = self.executor.purge_expired(self.storage, DataClass.TRAINING_DATA)
        self.assertEqual(deleted, 0)
        self.assertEqual(self.executor.dry_run(self.storage, DataClass.TRAINING_DATA), 0)


class PurgeAllTest(_BasePurgeTest):
    def test_purge_all_returns_dict_for_every_class(self):
        self._insert_telemetry("TS-OLD", _ts_days_ago(40))
        result = self.executor.purge_all(self.storage)
        # 每个 DataClass 都有条目
        self.assertEqual(set(result.keys()), {dc.value for dc in DataClass})
        # HIGH_FREQ_TELEMETRY 清理了 1 条
        self.assertEqual(result[DataClass.HIGH_FREQ_TELEMETRY.value], 1)
        # 永不清理的分级为 0
        self.assertEqual(result[DataClass.SPATIAL_BASEMAP.value], 0)
        self.assertEqual(result[DataClass.TRAINING_DATA.value], 0)

    def test_purge_all_accepts_string_data_class(self):
        # 字符串形式 data_class 也可清理
        self._insert_telemetry("TS-OLD", _ts_days_ago(40))
        deleted = self.executor.purge_expired(self.storage, "HIGH_FREQ_TELEMETRY")
        self.assertEqual(deleted, 1)


class BatchSizeTest(_BasePurgeTest):
    def test_batched_delete_with_small_batch(self):
        # 插入 5 条过期遥测，batch_size=2 → 应分 3 批（2+2+1）全部删除
        for i in range(5):
            self._insert_telemetry(f"TS-{i}", _ts_days_ago(40))
        deleted = self.executor.purge_expired(self.storage, DataClass.HIGH_FREQ_TELEMETRY, batch_size=2)
        self.assertEqual(deleted, 5)
        n = self.storage._db.execute("SELECT COUNT(*) c FROM telemetry").fetchone()["c"]
        self.assertEqual(n, 0)

    def test_batched_delete_default_batch_size(self):
        # 默认 batch_size=1000，一次性删除
        for i in range(3):
            self._insert_telemetry(f"TS-{i}", _ts_days_ago(40))
        deleted = self.executor.purge_expired(self.storage, DataClass.HIGH_FREQ_TELEMETRY)
        self.assertEqual(deleted, 3)


class AuditLoggingTest(_BasePurgeTest):
    def test_purge_writes_audit_log_via_storage(self):
        self._insert_telemetry("TS-OLD", _ts_days_ago(40))
        self.executor.purge_expired(self.storage, DataClass.HIGH_FREQ_TELEMETRY)
        # 清理审计日志已写入（action='purge', target_id='HIGH_FREQ_TELEMETRY'）
        purge_logs = self.storage.list_audit_logs(action="purge")
        self.assertEqual(len(purge_logs), 1)
        self.assertEqual(purge_logs[0]["target_type"], "data_class")
        self.assertEqual(purge_logs[0]["target_id"], "HIGH_FREQ_TELEMETRY")
        # after 记录删除条数
        self.assertEqual(purge_logs[0]["after"], {"deleted": 1})

    def test_custom_audit_logger_used(self):
        calls = []

        def logger(action, target_type, target_id, detail):
            calls.append((action, target_type, target_id, detail))

        exec_with_logger = PurgeExecutor(self.rm, audit_logger=logger)
        self._insert_telemetry("TS-OLD", _ts_days_ago(40))
        exec_with_logger.purge_expired(self.storage, DataClass.HIGH_FREQ_TELEMETRY)
        # 自定义 logger 被调用，且未写 storage.insert_audit_log
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], "purge")
        self.assertEqual(calls[0][1], "data_class")
        self.assertEqual(calls[0][2], "HIGH_FREQ_TELEMETRY")
        self.assertIn("deleted=1", calls[0][3])  # detail 含删除条数
        # storage 中无 purge 审计日志（用了自定义 logger）
        self.assertEqual(len(self.storage.list_audit_logs(action="purge")), 0)

    def test_no_audit_when_nothing_deleted(self):
        self._insert_telemetry("TS-NEW", _ts_days_ago(10))  # 未过期
        self.executor.purge_expired(self.storage, DataClass.HIGH_FREQ_TELEMETRY)
        # 无删除则不写审计
        self.assertEqual(len(self.storage.list_audit_logs(action="purge")), 0)


class CustomPolicyTest(_BasePurgeTest):
    def test_custom_shorter_policy_respected(self):
        # 注册 7 天策略（默认 30 天）→ 10 天前的记录应被清理
        self.rm.register(RetentionPolicy(data_class=DataClass.HIGH_FREQ_TELEMETRY, retention_days=7))
        self._insert_telemetry("TS-10D", _ts_days_ago(10))  # 超过 7 天 → 清理
        self._insert_telemetry("TS-3D", _ts_days_ago(3))  # 未超过 7 天 → 保留
        deleted = self.executor.purge_expired(self.storage, DataClass.HIGH_FREQ_TELEMETRY)
        self.assertEqual(deleted, 1)
        remaining = [r["record_id"] for r in self.storage._db.execute("SELECT record_id FROM telemetry").fetchall()]
        self.assertNotIn("TS-10D", remaining)
        self.assertIn("TS-3D", remaining)


if __name__ == "__main__":
    unittest.main()
