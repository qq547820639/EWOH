"""数据治理单元测试：授权管理 / 分层保留 / 模型与规则版本治理。

覆盖 spec「数据治理与隐私扩展」与场景「授权撤回」：
- ConsentManager：grant→is_allowed True、未授权用途/字段 False、revoke→is_allowed False、
  撤回产出 RevocationJob（含 delete/anonymize）、access_log 记录 check；
- RetentionManager：HIGH_FREQ_TELEMETRY 默认 30 天过期、AUDIT_LOG 未满 180 天不清理、
  SPATIAL_BASEMAP/TRAINING_DATA 永不清理、策略版本历史保留；
- ModelRegistry（Task 25 上线流程增强）：register→CANDIDATE、规范生命周期
  CANDIDATE→REVIEWING→SHADOW→CONTROLLED_VALIDATION→CANARY→ACTIVE→RETIRED、
  未经 CANARY 激活被拒、需 approver_id 人工批准、回滚到历史 ACTIVE 版本、active()
  返回当前、审计链已记录；promote_to_shadow 捷径仍可用。

纯 Python 标准库 unittest；运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_governance -v
"""

import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

# 支持 PYTHONPATH=src 与直接运行两种方式
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.governance import (
    DEFAULT_RETENTION,
    ConsentManager,
    ConsentPurpose,
    DataClass,
    ModelRecord,
    ModelRegistry,
    ModelStatus,
    RetentionManager,
    RetentionPolicy,
    RevocationJob,
)
from edge_platform.governance.model_registry import ACTION_CLASSIFIER
from edge_platform.inference import ts_to_ms


def _ts_days_ago(days):
    """返回 N 天前的 ISO 8601（毫秒精度，UTC）时间字符串。"""
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="milliseconds")


def _advance_to_canary(reg, model_id, submitter="submitter-1", reviewer="reviewer-1", canary_ratio=0.1):
    """Task 25：把模型按规范上线路径推进到 CANARY（激活前置状态）。

    CANDIDATE → submit_for_review → REVIEWING → approve_review → SHADOW →
    start_controlled_validation → CONTROLLED_VALIDATION → start_canary → CANARY。
    """
    reg.submit_for_review(model_id, submitter)
    reg.approve_review(model_id, reviewer)
    reg.start_controlled_validation(model_id)
    reg.start_canary(model_id, canary_ratio=canary_ratio)
    return reg.get(model_id)


# ---------- 授权管理 ----------
class ConsentManagerTest(unittest.TestCase):
    def test_grant_allows_and_revoke_denies(self):
        mgr = ConsentManager()
        rec = mgr.grant(
            "p1",
            [ConsentPurpose.TELEMETRY],
            ["load.torque"],
            "leader1",
            retention_rule="telemetry-30d",
        )
        self.assertEqual(rec.status, "ACTIVE")
        self.assertTrue(rec.record_id.startswith("CONSENT-"))
        self.assertEqual(rec.granted_by, "leader1")
        self.assertEqual(rec.retention_rule, "telemetry-30d")
        # 已授权用途 → True
        self.assertTrue(mgr.is_allowed("p1", ConsentPurpose.TELEMETRY))
        # 未授权用途 → False
        self.assertFalse(mgr.is_allowed("p1", ConsentPurpose.VIDEO))
        # 字段级：未授权字段 → False
        self.assertFalse(mgr.is_allowed("p1", ConsentPurpose.TELEMETRY, "video.frame"))
        # 授权字段 → True
        self.assertTrue(mgr.is_allowed("p1", ConsentPurpose.TELEMETRY, "load.torque"))

        # 撤回后 → False
        job = mgr.revoke(rec.record_id, "员工离职", "admin1")
        self.assertIsInstance(job, RevocationJob)
        self.assertEqual(rec.status, "REVOKED")
        self.assertIsNotNone(rec.revoked_at)
        self.assertEqual(rec.revocation_reason, "员工离职")
        self.assertFalse(mgr.is_allowed("p1", ConsentPurpose.TELEMETRY))
        self.assertFalse(mgr.is_allowed("p1", ConsentPurpose.TELEMETRY, "load.torque"))

    def test_revoke_produces_revocation_job_with_delete_and_anonymize(self):
        mgr = ConsentManager()
        rec = mgr.grant(
            "p1",
            [ConsentPurpose.TELEMETRY, ConsentPurpose.SKELETON, ConsentPurpose.TASK_BINDING],
            ["load.torque", "pose.spine"],
            "leader1",
        )
        job = mgr.revoke(rec.record_id, "员工撤回授权", "admin1")
        self.assertIsInstance(job, RevocationJob)
        self.assertEqual(job.person_id, "p1")
        self.assertTrue(job.job_id.startswith("REV-"))
        self.assertEqual(job.status, "PENDING")
        # 动作含 delete（TELEMETRY）/ anonymize（SKELETON）/ handover（TASK_BINDING）
        actions = {a["action"] for a in job.actions}
        self.assertIn("delete", actions)
        self.assertIn("anonymize", actions)
        self.assertIn("handover", actions)
        # 用途级动作覆盖三个用途
        purpose_actions = {a["data_class"]: a["action"] for a in job.actions if a["data_class"] != "field"}
        self.assertEqual(purpose_actions["TELEMETRY"], "delete")
        self.assertEqual(purpose_actions["SKELETON"], "anonymize")
        self.assertEqual(purpose_actions["TASK_BINDING"], "handover")
        # 字段级动作产出 anonymize（数据最小化回退）
        field_actions = [a for a in job.actions if a["data_class"] == "field"]
        self.assertEqual(len(field_actions), 2)
        self.assertTrue(all(a["action"] == "anonymize" for a in field_actions))
        # 每个 action 携带 target
        for a in job.actions:
            self.assertTrue(a["target"])

    def test_revoke_unknown_record_raises(self):
        mgr = ConsentManager()
        with self.assertRaises(KeyError):
            mgr.revoke("NOPE", "reason", "admin1")

    def test_double_revoke_raises(self):
        mgr = ConsentManager()
        rec = mgr.grant("p1", [ConsentPurpose.TELEMETRY], [], "leader1")
        mgr.revoke(rec.record_id, "第一次", "admin1")
        with self.assertRaises(ValueError):
            mgr.revoke(rec.record_id, "第二次", "admin1")

    def test_access_log_records_check_grant_revoke(self):
        mgr = ConsentManager()
        rec = mgr.grant("p1", [ConsentPurpose.TELEMETRY], ["load.torque"], "leader1")
        mgr.is_allowed("p1", ConsentPurpose.TELEMETRY)
        mgr.is_allowed("p1", ConsentPurpose.VIDEO)
        mgr.revoke(rec.record_id, "撤回", "admin1")

        actions = [e["action"] for e in mgr.access_log]
        # grant / check / revoke 均入审计
        self.assertIn("grant", actions)
        self.assertIn("check", actions)
        self.assertIn("revoke", actions)
        # 至少两条 check（TELEMETRY、VIDEO）
        self.assertGreaterEqual(actions.count("check"), 2)
        # check 条目携带 ts 与 allowed 结论
        checks = [e for e in mgr.access_log if e["action"] == "check"]
        self.assertTrue(all(e["ts"] for e in checks))
        self.assertIn("allowed=True", checks[0]["detail"])
        self.assertIn("allowed=False", checks[1]["detail"])
        # grant 条目记录授予人与用途
        grant_entry = [e for e in mgr.access_log if e["action"] == "grant"][0]
        self.assertEqual(grant_entry["actor_id"], "leader1")
        self.assertEqual(grant_entry["ref"], rec.record_id)
        self.assertIn("TELEMETRY", grant_entry["detail"])
        # 每条审计携带 log_id 与 ts
        for e in mgr.access_log:
            self.assertTrue(e["log_id"])
            self.assertTrue(e["ts"])

    def test_list_for_person_returns_all_records(self):
        mgr = ConsentManager()
        r1 = mgr.grant("p1", [ConsentPurpose.TELEMETRY], [], "leader1")
        r2 = mgr.grant("p1", [ConsentPurpose.VIDEO], [], "leader1")
        mgr.grant("p2", [ConsentPurpose.TELEMETRY], [], "leader1")
        recs = mgr.list_for_person("p1")
        self.assertEqual({r.record_id for r in recs}, {r1.record_id, r2.record_id})
        self.assertEqual(len(mgr.list_for_person("p2")), 1)
        self.assertEqual(mgr.list_for_person("unknown"), [])

    def test_string_purpose_accepted(self):
        # 字符串用途也可授权与查询（便于从外部数据恢复）
        mgr = ConsentManager()
        mgr.grant("p1", ["TELEMETRY"], [], "leader1")
        self.assertTrue(mgr.is_allowed("p1", "TELEMETRY"))


# ---------- 分层保留 ----------
class RetentionManagerTest(unittest.TestCase):
    def test_default_retention_values(self):
        self.assertEqual(DEFAULT_RETENTION[DataClass.HIGH_FREQ_TELEMETRY], 30)
        self.assertEqual(DEFAULT_RETENTION[DataClass.MINUTE_AGG], 365)
        self.assertEqual(DEFAULT_RETENTION[DataClass.EVENT_EVIDENCE], 90)
        self.assertEqual(DEFAULT_RETENTION[DataClass.SCHEDULE_TASK], 365)
        self.assertEqual(DEFAULT_RETENTION[DataClass.AUDIT_LOG], 180)
        self.assertEqual(DEFAULT_RETENTION[DataClass.SPATIAL_BASEMAP], -1)
        self.assertEqual(DEFAULT_RETENTION[DataClass.TRAINING_DATA], -1)

    def test_high_freq_telemetry_expires_in_30_days(self):
        mgr = RetentionManager()  # 未注册策略 → 用默认
        ts = "2026-01-01T00:00:00.000+00:00"
        exp = mgr.expire_by(DataClass.HIGH_FREQ_TELEMETRY, ts)
        self.assertEqual(exp - ts_to_ms(ts), 30 * 86400 * 1000)
        # MINUTE_AGG 默认 365 天
        exp_agg = mgr.expire_by(DataClass.MINUTE_AGG, ts)
        self.assertEqual(exp_agg - ts_to_ms(ts), 365 * 86400 * 1000)

    def test_expire_by_none_for_long_term(self):
        mgr = RetentionManager()
        ts = "2026-01-01T00:00:00.000+00:00"
        # 长期/版本化分级 → None（永不过期）
        self.assertIsNone(mgr.expire_by(DataClass.SPATIAL_BASEMAP, ts))
        self.assertIsNone(mgr.expire_by(DataClass.TRAINING_DATA, ts))

    def test_audit_log_never_purged_before_180_days(self):
        mgr = RetentionManager()
        young_ts = _ts_days_ago(100)  # 100 天前：未满 180，不应清理
        old_ts = _ts_days_ago(200)  # 200 天前：超过 180，应清理
        records = [
            {"data_class": DataClass.AUDIT_LOG, "record_ts": young_ts, "record_id": "a1"},
            {"data_class": DataClass.AUDIT_LOG, "record_ts": old_ts, "record_id": "a2"},
        ]
        due = mgr.purge_due(records)
        due_ids = {r["record_id"] for r in due}
        self.assertNotIn("a1", due_ids)
        self.assertIn("a2", due_ids)

    def test_audit_log_floor_enforced_even_if_policy_smaller(self):
        # 即便策略被改小到 30 天，AUDIT_LOG 仍至少保留 180 天
        mgr = RetentionManager()
        mgr.register(RetentionPolicy(data_class=DataClass.AUDIT_LOG, retention_days=30, note="违规改小"))
        young_ts = _ts_days_ago(100)  # 100 天前：策略 30 天已过，但 180 天未满 → 不清理
        old_ts = _ts_days_ago(200)
        records = [
            {"data_class": DataClass.AUDIT_LOG, "record_ts": young_ts, "record_id": "a1"},
            {"data_class": DataClass.AUDIT_LOG, "record_ts": old_ts, "record_id": "a2"},
        ]
        due_ids = {r["record_id"] for r in mgr.purge_due(records)}
        self.assertNotIn("a1", due_ids)
        self.assertIn("a2", due_ids)

    def test_spatial_basemap_and_training_data_never_purged(self):
        mgr = RetentionManager()
        very_old = _ts_days_ago(9999)
        records = [
            {"data_class": DataClass.SPATIAL_BASEMAP, "record_ts": very_old, "record_id": "b1"},
            {"data_class": DataClass.TRAINING_DATA, "record_ts": very_old, "record_id": "b2"},
        ]
        self.assertEqual(mgr.purge_due(records), [])

    def test_high_freq_telemetry_purge_due(self):
        mgr = RetentionManager()  # 默认 30 天
        records = [
            {"data_class": DataClass.HIGH_FREQ_TELEMETRY, "record_ts": _ts_days_ago(40), "record_id": "t1"},  # 过期
            {"data_class": DataClass.HIGH_FREQ_TELEMETRY, "record_ts": _ts_days_ago(10), "record_id": "t2"},  # 未过期
        ]
        due_ids = {r["record_id"] for r in mgr.purge_due(records)}
        self.assertIn("t1", due_ids)
        self.assertNotIn("t2", due_ids)

    def test_version_history_retained(self):
        mgr = RetentionManager()
        p1 = RetentionPolicy(data_class=DataClass.HIGH_FREQ_TELEMETRY, retention_days=7, policy_id="p1")
        p2 = RetentionPolicy(data_class=DataClass.HIGH_FREQ_TELEMETRY, retention_days=14, policy_id="p2")
        mgr.register(p1)
        mgr.register(p2)
        # 历史保留两版
        self.assertEqual(len(mgr.history(DataClass.HIGH_FREQ_TELEMETRY)), 2)
        # 版本递增、不覆盖
        self.assertEqual(p1.version, 1)
        self.assertEqual(p2.version, 2)
        # current 返回最新
        self.assertIs(mgr.current(DataClass.HIGH_FREQ_TELEMETRY), p2)
        # expire_by 使用当前策略（14 天），而非默认 30 天
        ts = "2026-01-01T00:00:00.000+00:00"
        self.assertEqual(mgr.expire_by(DataClass.HIGH_FREQ_TELEMETRY, ts) - ts_to_ms(ts), 14 * 86400 * 1000)

    def test_current_returns_none_when_unregistered(self):
        mgr = RetentionManager()
        self.assertIsNone(mgr.current(DataClass.EVENT_EVIDENCE))
        self.assertEqual(mgr.history(DataClass.EVENT_EVIDENCE), [])


# ---------- 模型与规则版本治理 ----------
class ModelRegistryTest(unittest.TestCase):
    def test_register_candidate(self):
        reg = ModelRegistry()
        rec = ModelRecord(
            model_type=ACTION_CLASSIFIER,
            version="1.0.0",
            data_version="ds-1",
            feature_version="f-1",
            threshold_version="t-1",
            model_card_uri="card://m1",
        )
        reg.register(rec)
        self.assertEqual(rec.status, ModelStatus.CANDIDATE)
        self.assertTrue(rec.model_id.startswith("MODEL-"))
        # 无生效模型
        self.assertIsNone(reg.active(ACTION_CLASSIFIER))
        # 审计链已记录 register
        self.assertTrue(any(e["action"] == "register" for e in reg.audit_trail))

    def test_register_unknown_model_type_rejected(self):
        with self.assertRaises(ValueError):
            ModelRecord(model_type="not_a_type", version="1.0.0")

    def test_activate_without_canary_refused(self):
        # Task 25：激活必须先经 CANARY（人工批准）；CANDIDATE 直接 activate → 拒绝
        reg = ModelRegistry()
        rec = ModelRecord(model_type=ACTION_CLASSIFIER, version="1.0.0")
        reg.register(rec)
        with self.assertRaises(ValueError):
            reg.activate(rec.model_id, "approver-1")
        # 状态不变
        self.assertEqual(rec.status, ModelStatus.CANDIDATE)
        self.assertIsNone(reg.active(ACTION_CLASSIFIER))

    def test_activate_after_full_flow(self):
        # Task 25：规范上线路径 CANDIDATE→…→CANARY→ACTIVE
        reg = ModelRegistry()
        rec = ModelRecord(model_type=ACTION_CLASSIFIER, version="1.0.0")
        reg.register(rec)
        _advance_to_canary(reg, rec.model_id)
        self.assertEqual(rec.status, ModelStatus.CANARY)
        activated = reg.activate(rec.model_id, "approver-1")
        self.assertEqual(activated.status, ModelStatus.ACTIVE)
        self.assertIsNotNone(activated.activated_at)
        self.assertIs(reg.active(ACTION_CLASSIFIER), activated)
        # approver_id 已记录
        self.assertEqual(activated.approver_id, "approver-1")

    def test_activate_requires_approver_id(self):
        # Task 25：activate 需人工 approver_id 批准
        reg = ModelRegistry()
        rec = ModelRecord(model_type=ACTION_CLASSIFIER, version="1.0.0")
        reg.register(rec)
        _advance_to_canary(reg, rec.model_id)
        with self.assertRaises(ValueError):
            reg.activate(rec.model_id, "")
        # 状态不变
        self.assertEqual(rec.status, ModelStatus.CANARY)

    def test_promote_to_shadow_requires_candidate(self):
        reg = ModelRegistry()
        rec = ModelRecord(model_type=ACTION_CLASSIFIER, version="1.0.0")
        reg.register(rec)
        reg.promote_to_shadow(rec.model_id, "r")
        # 已 SHADOW，再次 promote → 拒绝
        with self.assertRaises(ValueError):
            reg.promote_to_shadow(rec.model_id, "r")

    def test_activate_auto_retires_previous_active(self):
        reg = ModelRegistry()
        m1 = ModelRecord(model_id="m1", model_type=ACTION_CLASSIFIER, version="1.0.0")
        m2 = ModelRecord(model_id="m2", model_type=ACTION_CLASSIFIER, version="2.0.0")
        reg.register(m1)
        reg.register(m2)
        _advance_to_canary(reg, "m1")
        reg.activate("m1", "approver-1")
        self.assertEqual(reg.active(ACTION_CLASSIFIER).model_id, "m1")
        # 激活 m2 → m1 自动退役
        _advance_to_canary(reg, "m2")
        reg.activate("m2", "approver-2")
        self.assertEqual(reg.active(ACTION_CLASSIFIER).model_id, "m2")
        self.assertEqual(m1.status, ModelStatus.RETIRED)
        self.assertIsNotNone(m1.retired_at)

    def test_rollback_to_prior_active(self):
        reg = ModelRegistry()
        m1 = ModelRecord(model_id="m1", model_type=ACTION_CLASSIFIER, version="1.0.0")
        m2 = ModelRecord(model_id="m2", model_type=ACTION_CLASSIFIER, version="2.0.0")
        reg.register(m1)
        reg.register(m2)
        _advance_to_canary(reg, "m1")
        reg.activate("m1", "approver-1")
        _advance_to_canary(reg, "m2")
        reg.activate("m2", "approver-2")  # m1 自动退役
        self.assertEqual(reg.active(ACTION_CLASSIFIER).model_id, "m2")
        self.assertEqual(m1.status, ModelStatus.RETIRED)

        # 回滚到 m1
        rb = reg.rollback(ACTION_CLASSIFIER, "m1", "ref-rollback")
        self.assertEqual(rb.status, ModelStatus.ACTIVE)
        self.assertEqual(reg.active(ACTION_CLASSIFIER).model_id, "m1")
        # m2 让位置退役
        self.assertEqual(m2.status, ModelStatus.RETIRED)

    def test_rollback_to_candidate_refused(self):
        reg = ModelRegistry()
        m1 = ModelRecord(model_id="m1", model_type=ACTION_CLASSIFIER, version="1.0.0")
        m2 = ModelRecord(model_id="m2", model_type=ACTION_CLASSIFIER, version="2.0.0")
        reg.register(m1)
        reg.register(m2)
        _advance_to_canary(reg, "m1")
        reg.activate("m1", "approver-1")
        # m2 仍是 CANDIDATE（未曾 ACTIVE/SHADOW/CANARY）→ 不允许回滚到它
        with self.assertRaises(ValueError):
            reg.rollback(ACTION_CLASSIFIER, "m2", "ref")
        # 状态不变
        self.assertEqual(reg.active(ACTION_CLASSIFIER).model_id, "m1")
        self.assertEqual(m2.status, ModelStatus.CANDIDATE)

    def test_history_and_active(self):
        reg = ModelRegistry()
        m1 = ModelRecord(model_id="m1", model_type=ACTION_CLASSIFIER, version="1.0.0")
        m2 = ModelRecord(model_id="m2", model_type=ACTION_CLASSIFIER, version="2.0.0")
        reg.register(m1)
        reg.register(m2)
        self.assertEqual(len(reg.history(ACTION_CLASSIFIER)), 2)
        self.assertEqual([m.model_id for m in reg.history(ACTION_CLASSIFIER)], ["m1", "m2"])
        self.assertIsNone(reg.active(ACTION_CLASSIFIER))
        _advance_to_canary(reg, "m1")
        reg.activate("m1", "approver-1")
        self.assertEqual(reg.active(ACTION_CLASSIFIER).model_id, "m1")

    def test_retire(self):
        reg = ModelRegistry()
        m1 = ModelRecord(model_id="m1", model_type=ACTION_CLASSIFIER, version="1.0.0")
        reg.register(m1)
        _advance_to_canary(reg, "m1")
        reg.activate("m1", "approver-1")
        reg.retire("m1", "ref-retire")
        self.assertEqual(m1.status, ModelStatus.RETIRED)
        self.assertIsNotNone(m1.retired_at)
        self.assertIsNone(reg.active(ACTION_CLASSIFIER))

    def test_audit_trail_populated(self):
        reg = ModelRegistry()
        m1 = ModelRecord(
            model_id="m1",
            model_type=ACTION_CLASSIFIER,
            version="1.0.0",
            data_version="ds-1",
            feature_version="f-1",
            threshold_version="t-1",
        )
        reg.register(m1)
        _advance_to_canary(reg, "m1")
        reg.activate("m1", "approver-1")
        actions = [e["action"] for e in reg.audit_trail]
        self.assertIn("register", actions)
        self.assertIn("submit_for_review", actions)
        self.assertIn("approve_review", actions)
        self.assertIn("start_controlled_validation", actions)
        self.assertIn("start_canary", actions)
        self.assertIn("activate", actions)
        # 每条审计携带 ts / ref / from_status / to_status
        for e in reg.audit_trail:
            self.assertTrue(e["ts"])
            self.assertIn("from_status", e)
            self.assertIn("to_status", e)
        # register 审计携带数据/特征/阈值版本（可追溯）
        reg_entry = [e for e in reg.audit_trail if e["action"] == "register"][0]
        self.assertIn("ds-1", reg_entry["detail"])
        self.assertIn("f-1", reg_entry["detail"])
        self.assertIn("t-1", reg_entry["detail"])
        # activate 审计：actor_id=approver，from_status=CANARY→ACTIVE
        act_entry = [e for e in reg.audit_trail if e["action"] == "activate"][0]
        self.assertEqual(act_entry["actor_id"], "approver-1")
        self.assertEqual(act_entry["from_status"], "CANARY")
        self.assertEqual(act_entry["to_status"], "ACTIVE")

    # ---- Task 25：上线流程增强新增测试 ----
    def test_submit_for_review(self):
        reg = ModelRegistry()
        rec = ModelRecord(model_type=ACTION_CLASSIFIER, version="1.0.0")
        reg.register(rec)
        reg.submit_for_review(rec.model_id, "submitter-A")
        self.assertEqual(rec.status, ModelStatus.REVIEWING)
        # 审计记录提交人
        entry = [e for e in reg.audit_trail if e["action"] == "submit_for_review"][0]
        self.assertEqual(entry["actor_id"], "submitter-A")
        self.assertEqual(entry["to_status"], "REVIEWING")

    def test_submit_for_review_requires_candidate(self):
        reg = ModelRegistry()
        rec = ModelRecord(model_type=ACTION_CLASSIFIER, version="1.0.0")
        reg.register(rec)
        reg.submit_for_review(rec.model_id, "s")
        # 已 REVIEWING，再次提交 → 拒绝
        with self.assertRaises(ValueError):
            reg.submit_for_review(rec.model_id, "s")

    def test_approve_review_records_reviewer(self):
        reg = ModelRegistry()
        rec = ModelRecord(model_type=ACTION_CLASSIFIER, version="1.0.0")
        reg.register(rec)
        reg.submit_for_review(rec.model_id, "submitter-A")
        reg.approve_review(rec.model_id, "reviewer-B")
        self.assertEqual(rec.status, ModelStatus.SHADOW)
        # safety_reviewer_id 已记录
        self.assertEqual(rec.safety_reviewer_id, "reviewer-B")
        entry = [e for e in reg.audit_trail if e["action"] == "approve_review"][0]
        self.assertEqual(entry["actor_id"], "reviewer-B")
        self.assertEqual(entry["to_status"], "SHADOW")

    def test_approve_review_requires_reviewer_id(self):
        reg = ModelRegistry()
        rec = ModelRecord(model_type=ACTION_CLASSIFIER, version="1.0.0")
        reg.register(rec)
        reg.submit_for_review(rec.model_id, "s")
        with self.assertRaises(ValueError):
            reg.approve_review(rec.model_id, "")

    def test_approve_review_requires_reviewing(self):
        reg = ModelRegistry()
        rec = ModelRecord(model_type=ACTION_CLASSIFIER, version="1.0.0")
        reg.register(rec)
        # CANDIDATE 直接 approve_review → 拒绝
        with self.assertRaises(ValueError):
            reg.approve_review(rec.model_id, "reviewer-B")

    def test_start_controlled_validation(self):
        reg = ModelRegistry()
        rec = ModelRecord(model_type=ACTION_CLASSIFIER, version="1.0.0")
        reg.register(rec)
        reg.submit_for_review(rec.model_id, "s")
        reg.approve_review(rec.model_id, "r")
        reg.start_controlled_validation(rec.model_id)
        self.assertEqual(rec.status, ModelStatus.CONTROLLED_VALIDATION)

    def test_start_controlled_validation_requires_shadow(self):
        reg = ModelRegistry()
        rec = ModelRecord(model_type=ACTION_CLASSIFIER, version="1.0.0")
        reg.register(rec)
        # CANDIDATE 直接进入受控验证 → 拒绝
        with self.assertRaises(ValueError):
            reg.start_controlled_validation(rec.model_id)

    def test_start_canary_records_ratio(self):
        reg = ModelRegistry()
        rec = ModelRecord(model_type=ACTION_CLASSIFIER, version="1.0.0")
        reg.register(rec)
        reg.submit_for_review(rec.model_id, "s")
        reg.approve_review(rec.model_id, "r")
        reg.start_controlled_validation(rec.model_id)
        reg.start_canary(rec.model_id, canary_ratio=0.25)
        self.assertEqual(rec.status, ModelStatus.CANARY)
        self.assertEqual(rec.canary_ratio, 0.25)
        # 审计记录灰度比例
        entry = [e for e in reg.audit_trail if e["action"] == "start_canary"][0]
        self.assertIn("canary_ratio=0.25", entry["detail"])

    def test_start_canary_default_ratio(self):
        reg = ModelRegistry()
        rec = ModelRecord(model_type=ACTION_CLASSIFIER, version="1.0.0")
        reg.register(rec)
        reg.submit_for_review(rec.model_id, "s")
        reg.approve_review(rec.model_id, "r")
        reg.start_controlled_validation(rec.model_id)
        reg.start_canary(rec.model_id)
        self.assertEqual(rec.canary_ratio, 0.1)  # 默认 10%

    def test_start_canary_requires_controlled_validation(self):
        reg = ModelRegistry()
        rec = ModelRecord(model_type=ACTION_CLASSIFIER, version="1.0.0")
        reg.register(rec)
        reg.promote_to_shadow(rec.model_id, "r")  # SHADOW 但未受控验证
        with self.assertRaises(ValueError):
            reg.start_canary(rec.model_id)

    def test_full_lifecycle(self):
        # Task 25：完整生命周期 CANDIDATE→REVIEWING→SHADOW→
        # CONTROLLED_VALIDATION→CANARY→ACTIVE→RETIRED
        reg = ModelRegistry()
        rec = ModelRecord(
            model_type=ACTION_CLASSIFIER,
            version="1.0.0",
            data_version="ds-1",
            feature_version="f-1",
            threshold_version="t-1",
            model_card_uri="card://m1",
        )
        reg.register(rec)
        self.assertEqual(rec.status, ModelStatus.CANDIDATE)
        reg.submit_for_review(rec.model_id, "submitter-1")
        self.assertEqual(rec.status, ModelStatus.REVIEWING)
        reg.approve_review(rec.model_id, "reviewer-1")
        self.assertEqual(rec.status, ModelStatus.SHADOW)
        reg.start_controlled_validation(rec.model_id)
        self.assertEqual(rec.status, ModelStatus.CONTROLLED_VALIDATION)
        reg.start_canary(rec.model_id, canary_ratio=0.2)
        self.assertEqual(rec.status, ModelStatus.CANARY)
        reg.activate(rec.model_id, "approver-1")
        self.assertEqual(rec.status, ModelStatus.ACTIVE)
        self.assertEqual(rec.approver_id, "approver-1")
        self.assertEqual(rec.safety_reviewer_id, "reviewer-1")
        self.assertEqual(rec.canary_ratio, 0.2)
        reg.retire(rec.model_id, "ref-retire")
        self.assertEqual(rec.status, ModelStatus.RETIRED)
        # 全链路审计：每个流转都有记录
        to_statuses = [e["to_status"] for e in reg.audit_trail]
        for s in ("CANDIDATE", "REVIEWING", "SHADOW", "CONTROLLED_VALIDATION", "CANARY", "ACTIVE", "RETIRED"):
            self.assertIn(s, to_statuses)

    def test_state_transition_violations(self):
        # Task 25：非法状态流转均被拒绝
        reg = ModelRegistry()
        rec = ModelRecord(model_type=ACTION_CLASSIFIER, version="1.0.0")
        reg.register(rec)
        # CANDIDATE 不能直接 start_controlled_validation
        with self.assertRaises(ValueError):
            reg.start_controlled_validation(rec.model_id)
        # CANDIDATE 不能直接 start_canary
        with self.assertRaises(ValueError):
            reg.start_canary(rec.model_id)
        # CANDIDATE 不能直接 activate
        with self.assertRaises(ValueError):
            reg.activate(rec.model_id, "approver-1")
        # 进入 REVIEWING 后不能直接 activate（需经 SHADOW/CV/CANARY）
        reg.submit_for_review(rec.model_id, "s")
        with self.assertRaises(ValueError):
            reg.activate(rec.model_id, "approver-1")
        # REVIEWING 不能直接 start_controlled_validation（需先到 SHADOW）
        with self.assertRaises(ValueError):
            reg.start_controlled_validation(rec.model_id)
        # 状态不变
        self.assertEqual(rec.status, ModelStatus.REVIEWING)

    def test_promote_to_shadow_shortcut_still_works(self):
        # Task 25：promote_to_shadow 作为 CANDIDATE→SHADOW 捷径保留
        reg = ModelRegistry()
        rec = ModelRecord(model_type=ACTION_CLASSIFIER, version="1.0.0")
        reg.register(rec)
        reg.promote_to_shadow(rec.model_id, "ref-shadow")
        self.assertEqual(rec.status, ModelStatus.SHADOW)
        # 从 SHADOW 仍需走受控验证+灰度才能激活
        reg.start_controlled_validation(rec.model_id)
        reg.start_canary(rec.model_id)
        reg.activate(rec.model_id, "approver-1")
        self.assertEqual(rec.status, ModelStatus.ACTIVE)

    def test_to_dict_includes_new_fields(self):
        # Task 25：to_dict 包含新增字段
        rec = ModelRecord(model_type=ACTION_CLASSIFIER, version="1.0.0")
        d = rec.to_dict()
        self.assertIn("canary_ratio", d)
        self.assertIn("approver_id", d)
        self.assertIn("safety_reviewer_id", d)
        self.assertIsNone(d["canary_ratio"])
        self.assertIsNone(d["approver_id"])
        self.assertIsNone(d["safety_reviewer_id"])


if __name__ == "__main__":
    unittest.main()
