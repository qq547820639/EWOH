"""员工申诉通道单元测试：提交 / 认领 / 处理 / 驳回 / 查询 / 统计 / 审计。

覆盖 spec Task 25.4「员工申诉、标记误判、说明特殊情况通道」验收要求：
- submit 成功且字段完整；无效 appeal_type / 空 description / 缺 target_ref 字段均报错；
- acknowledge 状态 PENDING → REVIEWING；
- resolve 成功且状态变更；无效 resolution_action 报错；已 RESOLVED 不可再处理；
- reject 成功；
- list_by_appellant / list_by_target / list_pending 查询正确；
- stats 计数正确；
- audit_log 记录完整（submit/acknowledge/resolve/reject 各一条）。

纯 Python 标准库 unittest；运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_appeal -v
  python -m pytest src/edge_platform/tests/test_appeal.py -v
"""

import os
import sys
import unittest

# 支持 PYTHONPATH=src 与直接运行两种方式
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.scheduler import (
    AppealChannel,
    AppealRecord,
    AppealStats,
    AppealType,
)


def _target(kind="risk_event", id_="EV-0001"):
    return {"kind": kind, "id": id_}


# ---------- 提交 ----------
class SubmitTest(unittest.TestCase):
    def test_submit_success_fields_complete(self):
        ch = AppealChannel()
        rec = ch.submit(
            "p1",
            AppealType.MISJUDGEMENT,
            _target("recognition_result", "REC-1"),
            "动作识别为弯腰，实际为蹲下",
            evidence_refs=["clip-001", "witness-leader"],
        )
        self.assertIsInstance(rec, AppealRecord)
        self.assertTrue(rec.appeal_id.startswith("APPEAL-"))
        self.assertEqual(rec.appellant_id, "p1")
        self.assertEqual(rec.appeal_type, "misjudgement")
        self.assertEqual(rec.target_ref, {"kind": "recognition_result", "id": "REC-1"})
        self.assertEqual(rec.description, "动作识别为弯腰，实际为蹲下")
        self.assertEqual(rec.evidence_refs, ["clip-001", "witness-leader"])
        self.assertEqual(rec.status, "PENDING")
        self.assertIsNone(rec.resolved_by)
        self.assertIsNone(rec.resolution)
        self.assertIsNone(rec.resolution_action)
        self.assertIsNone(rec.resolved_at)
        # ts 可解析为毫秒
        self.assertIsInstance(rec.ts_ms, int)
        # evidence_refs 默认空列表
        rec2 = ch.submit("p1", AppealType.SPECIAL_CIRCUMSTANCE, _target(), "临时身体不适")
        self.assertEqual(rec2.evidence_refs, [])

    def test_submit_invalid_appeal_type_raises(self):
        ch = AppealChannel()
        with self.assertRaises(ValueError):
            ch.submit("p1", "not_a_type", _target(), "说明")

    def test_submit_empty_description_raises(self):
        ch = AppealChannel()
        with self.assertRaises(ValueError):
            ch.submit("p1", AppealType.MISJUDGEMENT, _target(), "")
        with self.assertRaises(ValueError):
            ch.submit("p1", AppealType.MISJUDGEMENT, _target(), "   ")

    def test_submit_missing_target_ref_fields_raises(self):
        ch = AppealChannel()
        # 缺 id
        with self.assertRaises(ValueError):
            ch.submit("p1", AppealType.MISJUDGEMENT, {"kind": "risk_event"}, "说明")
        # 缺 kind
        with self.assertRaises(ValueError):
            ch.submit("p1", AppealType.MISJUDGEMENT, {"id": "EV-1"}, "说明")
        # 非 dict
        with self.assertRaises(ValueError):
            ch.submit("p1", AppealType.MISJUDGEMENT, "risk_event/EV-1", "说明")

    def test_submit_accepts_string_appeal_type(self):
        ch = AppealChannel()
        rec = ch.submit("p1", "data_dispute", _target("sensor", "S-1"), "数据异常")
        self.assertEqual(rec.appeal_type, "data_dispute")


# ---------- 认领 / 处理 / 驳回 ----------
class LifecycleTest(unittest.TestCase):
    def test_acknowledge_state_transition(self):
        ch = AppealChannel()
        rec = ch.submit("p1", AppealType.SCHEDULING_OBJECTION, _target("schedule_request", "REQ-1"), "负荷评分过高")
        out = ch.acknowledge(rec.appeal_id, "leader1")
        self.assertEqual(out.status, "REVIEWING")
        self.assertEqual(out.resolved_by, "leader1")
        # 已 REVIEWING 不可再次 acknowledge
        with self.assertRaises(ValueError):
            ch.acknowledge(rec.appeal_id, "leader2")

    def test_resolve_success_state_transition(self):
        ch = AppealChannel()
        rec = ch.submit("p1", AppealType.MISJUDGEMENT, _target("recognition_result", "REC-1"), "识别错误")
        out = ch.resolve(rec.appeal_id, "leader1", "已更正识别结果", "correct_data")
        self.assertEqual(out.status, "RESOLVED")
        self.assertEqual(out.resolved_by, "leader1")
        self.assertEqual(out.resolution, "已更正识别结果")
        self.assertEqual(out.resolution_action, "correct_data")
        self.assertIsNotNone(out.resolved_at)

    def test_resolve_invalid_action_raises(self):
        ch = AppealChannel()
        rec = ch.submit("p1", AppealType.MISJUDGEMENT, _target(), "说明")
        with self.assertRaises(ValueError):
            ch.resolve(rec.appeal_id, "leader1", "处理说明", "invalid_action")
        # 空 resolution 也要报错
        with self.assertRaises(ValueError):
            ch.resolve(rec.appeal_id, "leader1", "   ", "acknowledge")

    def test_resolve_already_resolved_raises(self):
        ch = AppealChannel()
        rec = ch.submit("p1", AppealType.MISJUDGEMENT, _target(), "说明")
        ch.resolve(rec.appeal_id, "leader1", "已确认", "acknowledge")
        # 已 RESOLVED 不可再处理
        with self.assertRaises(ValueError):
            ch.resolve(rec.appeal_id, "leader1", "再次处理", "acknowledge")
        # 也不可再 acknowledge
        with self.assertRaises(ValueError):
            ch.acknowledge(rec.appeal_id, "leader1")

    def test_reject_success(self):
        ch = AppealChannel()
        rec = ch.submit("p1", AppealType.DATA_DISPUTE, _target(), "数据争议")
        out = ch.reject(rec.appeal_id, "leader1", "证据不足，驳回")
        self.assertEqual(out.status, "REJECTED")
        self.assertEqual(out.resolved_by, "leader1")
        self.assertEqual(out.resolution, "证据不足，驳回")
        self.assertIsNotNone(out.resolved_at)
        # 已 REJECTED 不可再驳回 / 处理
        with self.assertRaises(ValueError):
            ch.reject(rec.appeal_id, "leader1", "再次驳回")
        with self.assertRaises(ValueError):
            ch.resolve(rec.appeal_id, "leader1", "处理", "acknowledge")

    def test_get_missing_raises(self):
        ch = AppealChannel()
        with self.assertRaises(KeyError):
            ch.get("APPEAL-not-exist")


# ---------- 查询 ----------
class QueryTest(unittest.TestCase):
    def _seed(self):
        ch = AppealChannel()
        r1 = ch.submit("p1", AppealType.MISJUDGEMENT, _target("recognition_result", "REC-1"), "识别错误")
        r2 = ch.submit("p1", AppealType.SCHEDULING_OBJECTION, _target("schedule_request", "REQ-1"), "负荷过高")
        r3 = ch.submit("p2", AppealType.MISJUDGEMENT, _target("recognition_result", "REC-1"), "我也是误判")
        r4 = ch.submit("p2", AppealType.SPECIAL_CIRCUMSTANCE, _target("risk_event", "EV-9"), "身体不适")
        return ch, r1, r2, r3, r4

    def test_list_by_appellant(self):
        ch, r1, r2, r3, r4 = self._seed()
        p1 = ch.list_by_appellant("p1")
        self.assertEqual({r.appeal_id for r in p1}, {r1.appeal_id, r2.appeal_id})
        p2 = ch.list_by_appellant("p2")
        self.assertEqual({r.appeal_id for r in p2}, {r3.appeal_id, r4.appeal_id})
        self.assertEqual(ch.list_by_appellant("nobody"), [])

    def test_list_by_target(self):
        ch, r1, r2, r3, r4 = self._seed()
        # 同一对象 REC-1 被 p1、p2 各申诉一次
        hits = ch.list_by_target("recognition_result", "REC-1")
        self.assertEqual({r.appeal_id for r in hits}, {r1.appeal_id, r3.appeal_id})
        self.assertEqual(ch.list_by_target("recognition_result", "MISS"), [])

    def test_list_pending(self):
        ch, r1, r2, r3, r4 = self._seed()
        # 初始全部待处理
        self.assertEqual(len(ch.list_pending()), 4)
        # 认领一个（REVIEWING 仍属待处理）
        ch.acknowledge(r1.appeal_id, "leader1")
        self.assertEqual(len(ch.list_pending()), 4)
        # 处理一个 → 待处理 -1
        ch.resolve(r1.appeal_id, "leader1", "已更正", "correct_data")
        self.assertEqual(len(ch.list_pending()), 3)
        # 驳回一个 → 待处理 -1
        ch.reject(r2.appeal_id, "leader1", "证据不足")
        self.assertEqual(len(ch.list_pending()), 2)


# ---------- 统计 ----------
class StatsTest(unittest.TestCase):
    def test_stats_counts(self):
        ch = AppealChannel()
        r1 = ch.submit("p1", AppealType.MISJUDGEMENT, _target("recognition_result", "REC-1"), "误判1")
        r2 = ch.submit("p1", AppealType.MISJUDGEMENT, _target("recognition_result", "REC-2"), "误判2")
        r3 = ch.submit("p2", AppealType.SCHEDULING_OBJECTION, _target("schedule_request", "REQ-1"), "异议")
        ch.submit("p2", AppealType.DATA_DISPUTE, _target("sensor", "S-1"), "争议")

        # 初始：total=4 pending=4 resolved=0 rejected=0
        s = ch.stats()
        self.assertIsInstance(s, AppealStats)
        self.assertEqual(s.total, 4)
        self.assertEqual(s.pending, 4)
        self.assertEqual(s.resolved, 0)
        self.assertEqual(s.rejected, 0)
        self.assertEqual(
            s.by_type,
            {
                "misjudgement": 2,
                "scheduling_objection": 1,
                "data_dispute": 1,
            },
        )
        self.assertEqual(s.by_resolution_action, {})

        # 处理 r1（correct_data）、驳回 r2、认领 r3（REVIEWING 仍属 pending）
        ch.resolve(r1.appeal_id, "leader1", "已更正", "correct_data")
        ch.reject(r2.appeal_id, "leader1", "证据不足")
        ch.acknowledge(r3.appeal_id, "leader1")

        s2 = ch.stats()
        self.assertEqual(s2.total, 4)
        # pending = PENDING(r4) + REVIEWING(r3) = 2
        self.assertEqual(s2.pending, 2)
        self.assertEqual(s2.resolved, 1)
        self.assertEqual(s2.rejected, 1)
        self.assertEqual(s2.by_resolution_action, {"correct_data": 1})
        # by_type 不变
        self.assertEqual(
            s2.by_type,
            {
                "misjudgement": 2,
                "scheduling_objection": 1,
                "data_dispute": 1,
            },
        )


# ---------- 审计 ----------
class AuditLogTest(unittest.TestCase):
    def test_audit_log_complete(self):
        ch = AppealChannel()
        rec = ch.submit(
            "p1", AppealType.MISJUDGEMENT, _target("recognition_result", "REC-1"), "识别错误", evidence_refs=["clip-1"]
        )
        ch.acknowledge(rec.appeal_id, "leader1")
        ch.resolve(rec.appeal_id, "leader1", "已更正", "correct_data")

        rec2 = ch.submit("p2", AppealType.DATA_DISPUTE, _target("sensor", "S-1"), "争议")
        ch.reject(rec2.appeal_id, "leader2", "证据不足")

        log = ch.audit_log()
        # 4 类动作各一条，顺序与操作顺序一致
        actions = [e["action"] for e in log]
        self.assertEqual(
            actions,
            [
                "submit",
                "acknowledge",
                "resolve",
                "submit",
                "reject",
            ],
        )
        # 每条结构完整
        for e in log:
            self.assertIn("ts", e)
            self.assertIn("actor", e)
            self.assertIn("action", e)
            self.assertIn("appeal_id", e)
            self.assertIn("details", e)
        # submit 条目 actor 为申诉人
        self.assertEqual(log[0]["actor"], "p1")
        self.assertEqual(log[0]["appeal_id"], rec.appeal_id)
        self.assertIn("misjudgement", log[0]["details"])
        # resolve 条目 details 含动作
        self.assertIn("correct_data", log[2]["details"])
        # reject 条目 appeal_id 指向 rec2
        self.assertEqual(log[4]["appeal_id"], rec2.appeal_id)
        self.assertEqual(log[4]["actor"], "leader2")
        # 返回的是副本，修改不影响内部
        log.append({"tampered": True})
        self.assertEqual(len(ch.audit_log()), 5)


if __name__ == "__main__":
    unittest.main()
