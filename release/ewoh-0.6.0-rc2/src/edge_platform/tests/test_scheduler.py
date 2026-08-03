"""决策与调度层单元测试：硬约束 / 候选生成 / 评分 / 权重审计 / 理由 / 人在回路编排。

覆盖 spec「决策与调度层」与「人在回路与调度纪律」验收要求：
- 硬约束拦截（技能缺失→违规，具备→通过）；
- 候选生成保留失败候选并附违规原因；
- 多目标评分权重正确、分项贡献之和等于总分；
- 权重调整入审计（前后值/操作人/原因）；
- 理由生成引用真实计算值，失败候选理由含违规；
- 调度编排：propose→SHADOW、confirm 无理由拒绝、execute 未确认拒绝、确认后 EXECUTED、
  feedback 回流；
- 安全不变量：任何非 CONFIRMED 状态执行均被拒绝，无自动执行旁路。

纯 Python 标准库 unittest；运行：PYTHONPATH=src python -m unittest edge_platform.tests.test_scheduler -v
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.scheduler import (
    CONFIRMED,
    DEVICE_FAULT,
    EXECUTED,
    EXO_MODEL_COMPAT,
    FORBIDDEN_ZONE,
    HEALTH_TABOO,
    PROPOSED,
    REJECTED,
    SHADOW,
    SHIFT_REST,
    SKILL,
    STATION_AUTH,
    Candidate,
    CandidateGenerator,
    ConstraintViolation,
    Explanation,
    HardConstraints,
    Scheduler,
    ScheduleRequest,
    Scorer,
    ScoringWeights,
    WeightAuditLog,
    explain_candidate,
    explain_plan,
)
from edge_platform.spatial import Pose, distance


# ---------- 硬约束 ----------
class HardConstraintsTest(unittest.TestCase):
    def test_person_without_skill_violation(self):
        constraints = HardConstraints(
            skills_registry={"p1": {"lifting"}},
            station_auth={"p1": {"s1"}, "p2": {"s1"}},  # 二者工位均授权，仅技能不同
        )
        task = {"task_id": "t1", "required_skills": {"lifting"}, "station_id": "s1"}
        device = {"device_id": "d1", "model": "exoA"}

        # p1 具备技能且工位已授权 → 通过
        vs = constraints.check({"person_id": "p1"}, task, device, {})
        self.assertEqual(vs, [])

        # p2 不具备技能 → 仅 SKILL 违规
        vs2 = constraints.check({"person_id": "p2"}, task, device, {})
        self.assertEqual(len(vs2), 1)
        self.assertEqual(vs2[0].constraint_type, SKILL)
        self.assertEqual(vs2[0].person_id, "p2")
        self.assertIn("lifting", vs2[0].reason)

    def test_multiple_constraint_types(self):
        constraints = HardConstraints(
            skills_registry={"p1": {"lifting"}},
            station_auth={"p1": {"s1"}},
            health_restrictions={"p1": {"HIGH"}},
            forbidden_zones={"z_forbidden"},
            shift_rules={"shiftA": {"rest_minutes_per_hour": 10, "max_continuous_minutes": 120}},
            exo_compat={"exoA": {"carry"}},
            device_faults={"d_fault"},
        )
        person = {"person_id": "p1", "shift_id": "shiftA"}
        task = {
            "task_id": "t1",
            "required_skills": {"lifting"},
            "station_id": "s1",
            "zone_id": "z_forbidden",
            "load_level": "HIGH",
            "action_type": "carry",
            "exo_requirements": {"carry"},
        }
        device = {"device_id": "d_fault", "model": "exoA"}
        ctx = {"continuous_minutes": 200.0}
        ctypes = {v.constraint_type for v in constraints.check(person, task, device, ctx)}
        # 命中：禁区 / 健康禁忌 / 班次休息 / 设备故障
        self.assertIn(FORBIDDEN_ZONE, ctypes)
        self.assertIn(HEALTH_TABOO, ctypes)
        self.assertIn(SHIFT_REST, ctypes)
        self.assertIn(DEVICE_FAULT, ctypes)
        # 未命中：技能具备、工位已授权、外骨骼型号兼容
        self.assertNotIn(SKILL, ctypes)
        self.assertNotIn(STATION_AUTH, ctypes)
        self.assertNotIn(EXO_MODEL_COMPAT, ctypes)

    def test_station_auth_violation(self):
        constraints = HardConstraints(station_auth={"p1": {"s1"}})
        task = {"task_id": "t1", "station_id": "s2"}
        vs = constraints.check({"person_id": "p1"}, task, {"device_id": "d1"}, {})
        self.assertEqual(len(vs), 1)
        self.assertEqual(vs[0].constraint_type, STATION_AUTH)

    def test_violation_rejects_unknown_type(self):
        with self.assertRaises(ValueError):
            ConstraintViolation("NOT_A_TYPE", "p1", "x")


# ---------- 候选生成 ----------
class CandidateGeneratorTest(unittest.TestCase):
    def test_generates_candidates_keeps_failed(self):
        constraints = HardConstraints(
            skills_registry={"p1": {"lifting"}},
            station_auth={"p1": {"s1"}, "p2": {"s1"}},  # 二者工位均授权，仅技能不同
        )
        task = {"task_id": "t1", "required_skills": {"lifting"}, "station_id": "s1"}
        persons = [{"person_id": "p1"}, {"person_id": "p2"}]
        devices = [{"device_id": "d1", "model": "exoA"}]
        gen = CandidateGenerator()
        cands = gen.generate(task, persons, devices, constraints, {})
        # 每人每设备一个候选 → 2 个
        self.assertEqual(len(cands), 2)
        by_person = {c.person_id: c for c in cands}
        # p1 通过
        self.assertTrue(by_person["p1"].passed)
        self.assertEqual(by_person["p1"].violations, [])
        # p2 失败但保留，passed=False 且含违规原因
        self.assertFalse(by_person["p2"].passed)
        self.assertEqual(len(by_person["p2"].violations), 1)
        self.assertEqual(by_person["p2"].violations[0].constraint_type, SKILL)
        # 候选 id 已生成
        self.assertTrue(by_person["p1"].candidate_id.startswith("CAND-"))


# ---------- 评分 ----------
class ScorerTest(unittest.TestCase):
    def test_weights_applied_and_breakdown_sums_to_total(self):
        weights = ScoringWeights(
            w1_production=2.0,
            w2_on_time=1.0,
            w3_safety_risk=1.0,
            w4_body_load=1.0,
            w5_travel_distance=0.1,
            w6_changeover_cost=1.0,
        )
        scorer = Scorer(weights, WeightAuditLog())
        cand = Candidate(person_id="p1", device_id="d1", task_id="t1", station_id="s1")
        ctx = {
            "expected_production_uplift": 0.5,
            "on_time_probability": 0.8,
            "safety_risk": 0.3,
            "current_load": 0.6,
            "distance_to_station": 10.0,
            "is_changeover": True,
        }
        total, bd = scorer.score(cand, ctx)
        expected = 2.0 * 0.5 + 1.0 * 0.8 - 1.0 * 0.3 - 1.0 * 0.6 - 0.1 * 10.0 - 1.0 * 1.0
        self.assertAlmostEqual(total, expected, places=9)
        # 分项加权贡献之和 == 总分
        contrib_sum = (
            bd["w1_production_contrib"]
            + bd["w2_on_time_contrib"]
            + bd["w3_safety_contrib"]
            + bd["w4_body_load_contrib"]
            + bd["w5_travel_contrib"]
            + bd["w6_changeover_contrib"]
        )
        self.assertAlmostEqual(contrib_sum, total, places=9)
        self.assertAlmostEqual(bd["total"], total, places=9)
        # 各分量原值正确
        self.assertAlmostEqual(bd["production_score"], 0.5)
        self.assertAlmostEqual(bd["on_time_score"], 0.8)
        self.assertAlmostEqual(bd["safety_risk"], 0.3)
        self.assertAlmostEqual(bd["body_load"], 0.6)
        self.assertAlmostEqual(bd["travel_distance"], 10.0)
        self.assertAlmostEqual(bd["changeover_cost"], 1.0)

    def test_travel_distance_from_spatial_distance(self):
        weights = ScoringWeights()
        scorer = Scorer(weights, WeightAuditLog())
        cand = Candidate(person_id="p1", device_id="d1", task_id="t1", station_id="s1")
        ctx = {
            "person_pose": Pose(x=0.0, y=0.0),
            "station_pose": Pose(x=3.0, y=4.0),
            "expected_production_uplift": 0.0,
            "on_time_probability": 0.0,
            "current_load": 0.0,
        }
        _, bd = scorer.score(cand, ctx)
        # 复用 edge_platform.spatial.distance：3-4-5 直角三角形
        self.assertAlmostEqual(bd["travel_distance"], 5.0, places=9)
        self.assertAlmostEqual(distance(Pose(0, 0), Pose(3, 4)), 5.0, places=9)

    def test_safety_risk_derived_from_events(self):
        scorer = Scorer(ScoringWeights(), WeightAuditLog())
        cand = Candidate(person_id="p1", device_id="d1", task_id="t1", station_id="s1")
        ctx = {"recent_risk_events": ["e1", "e2", "e3"]}  # 0.2*3 = 0.6
        _, bd = scorer.score(cand, ctx)
        self.assertAlmostEqual(bd["safety_risk"], 0.6, places=9)
        # 上限 1.0
        ctx2 = {"recent_risk_events": list(range(20))}
        _, bd2 = scorer.score(cand, ctx2)
        self.assertAlmostEqual(bd2["safety_risk"], 1.0, places=9)


# ---------- 权重审计 ----------
class WeightAuditLogTest(unittest.TestCase):
    def test_set_weights_records_audit(self):
        w_before = ScoringWeights(w1_production=1.0, w6_changeover_cost=0.5)
        audit = WeightAuditLog()
        scorer = Scorer(w_before, audit)
        self.assertEqual(audit.history(), [])

        w_after = ScoringWeights(w1_production=1.5, w6_changeover_cost=0.8)
        entry = scorer.set_weights(w_after, actor_id="leader1", reason="产能优先，提升产量与换岗权重")
        self.assertEqual(len(audit.history()), 1)
        self.assertIs(audit.history()[0], entry)
        self.assertEqual(entry.actor_id, "leader1")
        self.assertIn("产能优先", entry.reason)
        self.assertAlmostEqual(entry.weights_before["w1_production"], 1.0)
        self.assertAlmostEqual(entry.weights_after["w1_production"], 1.5)
        self.assertAlmostEqual(entry.weights_before["w6_changeover_cost"], 0.5)
        self.assertAlmostEqual(entry.weights_after["w6_changeover_cost"], 0.8)
        # 权重确实已更新
        self.assertIs(scorer.weights, w_after)
        # 多次调整均入审计
        scorer.set_weights(ScoringWeights(), "leader2", "回滚默认")
        self.assertEqual(len(audit.history()), 2)


# ---------- 理由生成 ----------
class ExplanationTest(unittest.TestCase):
    def test_explain_passed_candidate_references_real_values(self):
        cand = Candidate(person_id="p1", device_id="d1", task_id="t1", station_id="s1", passed=True)
        cand.score = 0.42
        cand.score_breakdown = {
            "production_score": 0.5,
            "on_time_score": 0.8,
            "safety_risk": 0.1,
            "body_load": 0.71,
            "travel_distance": 12.3,
            "changeover_cost": 0.0,
            "w1_production_contrib": 0.5,
            "w2_on_time_contrib": 0.8,
            "w3_safety_contrib": -0.1,
            "w4_body_load_contrib": -0.71,
            "w5_travel_contrib": -0.615,
            "w6_changeover_contrib": 0.0,
            "total": 0.42,
            "body_load_baseline": 0.55,
        }
        exp = explain_candidate(cand)
        self.assertIsInstance(exp, Explanation)
        self.assertTrue(exp.reasons)
        text = "".join(exp.reasons)
        # 引用真实计算值
        self.assertIn("0.420", text)  # 综合评分
        self.assertIn("0.71", text)  # 累计负荷
        self.assertIn("0.55", text)  # 个人基线
        self.assertIn("12.3", text)  # 移动距离
        self.assertIn("低负荷工位", text)  # 高于基线建议
        # 中文理由
        self.assertTrue(any("\u4e00" <= ch <= "\u9fff" for r in exp.reasons for ch in r))

    def test_explain_failed_candidate_includes_violation(self):
        v = ConstraintViolation(SKILL, "p2", "人员 p2 缺少任务所需技能：lifting")
        cand = Candidate(person_id="p2", device_id="d1", task_id="t1", station_id="s1", violations=[v], passed=False)
        exp = explain_candidate(cand)
        text = "".join(exp.reasons)
        self.assertIn("硬约束拦截", text)
        self.assertIn("SKILL", text)
        self.assertIn("lifting", text)
        self.assertFalse(exp.evidence["passed"])

    def test_explain_plan_summarizes(self):
        c1 = Candidate(
            person_id="p1",
            device_id="d1",
            task_id="t1",
            station_id="s1",
            passed=True,
            score=0.9,
            score_breakdown={"total": 0.9, "body_load": 0.3, "body_load_baseline": 0.5},
        )
        c2 = Candidate(
            person_id="p2",
            device_id="d1",
            task_id="t1",
            station_id="s1",
            passed=False,
            violations=[ConstraintViolation(SKILL, "p2", "缺技能")],
        )
        exp = explain_plan([c1, c2])
        text = "".join(exp.reasons)
        self.assertIn("2 个候选", text)
        self.assertIn("推荐候选", text)
        self.assertIn("p1", text)
        self.assertIn("SKILL", text)
        self.assertEqual(exp.evidence["passed_count"], 1)
        self.assertEqual(exp.evidence["failed_count"], 1)


# ---------- 编排（人在回路） ----------
class SchedulerTest(unittest.TestCase):
    def _constraints(self):
        return HardConstraints(
            skills_registry={"p1": {"lifting"}, "p2": set()},
            station_auth={"p1": {"s1"}},
        )

    def _propose(self, sched):
        task = {"task_id": "t1", "required_skills": {"lifting"}, "station_id": "s1", "zone_id": "z1"}
        persons = [{"person_id": "p1"}, {"person_id": "p2"}]
        devices = [{"device_id": "d1", "model": "exoA"}]
        ctx = {
            "persons_state": {
                "p1": {
                    "current_load": 0.4,
                    "expected_production_uplift": 0.5,
                    "on_time_probability": 0.8,
                    "pose": Pose(x=0.0, y=0.0),
                },
            },
            "stations_state": {"s1": {"pose": Pose(x=3.0, y=4.0)}},
        }
        return sched.propose(task, persons, devices, ctx)

    def test_propose_returns_shadow_and_ranks(self):
        sched = Scheduler(self._constraints())
        req = self._propose(sched)
        self.assertEqual(req.status, SHADOW)
        self.assertIsInstance(req, ScheduleRequest)
        self.assertTrue(req.candidates)
        # p1 通过且已评分；p2 被拦截
        p1 = [c for c in req.candidates if c.person_id == "p1"][0]
        p2 = [c for c in req.candidates if c.person_id == "p2"][0]
        self.assertTrue(p1.passed)
        self.assertIsNotNone(p1.score)
        self.assertTrue(p1.explanation.reasons)
        self.assertFalse(p2.passed)
        # 排序：通过的在前
        self.assertEqual(req.candidates[0].person_id, "p1")
        # travel_distance 经 spatial.distance 计算 = 5.0
        self.assertAlmostEqual(p1.score_breakdown["travel_distance"], 5.0, places=9)

    def test_confirm_without_reason_raises(self):
        sched = Scheduler(self._constraints())
        req = self._propose(sched)
        with self.assertRaises(ValueError):
            sched.confirm(req.request_id, "plan-1", "leader1", "")
        with self.assertRaises(ValueError):
            sched.confirm(req.request_id, "plan-1", "leader1", "   ")
        # 状态未变
        self.assertEqual(req.status, SHADOW)
        self.assertEqual(req.confirmations, [])

    def test_execute_without_confirm_refused(self):
        sched = Scheduler(self._constraints())
        req = self._propose(sched)
        rec = sched.execute(req.request_id)
        self.assertFalse(rec["executed"])
        self.assertIn("未经确认不得自动执行", rec["reason"])
        # 状态保持 SHADOW
        self.assertEqual(req.status, SHADOW)
        self.assertIsNone(req.execution_record)

    def test_execute_after_confirm_executed(self):
        sched = Scheduler(self._constraints())
        req = self._propose(sched)
        plan_id = req.candidates[0].candidate_id
        rec = sched.confirm(req.request_id, plan_id, "leader1", "产量优先且负荷可控")
        self.assertEqual(rec["actor_id"], "leader1")
        self.assertEqual(rec["reason"], "产量优先且负荷可控")
        self.assertEqual(req.status, CONFIRMED)
        self.assertEqual(req.confirmed_plan_id, plan_id)
        ex = sched.execute(req.request_id)
        self.assertTrue(ex["executed"])
        self.assertEqual(req.status, EXECUTED)
        self.assertIsNotNone(req.execution_record)

    def test_feedback_recorded(self):
        sched = Scheduler(self._constraints())
        req = self._propose(sched)
        sched.confirm(req.request_id, "plan-1", "leader1", "综合最优")
        sched.execute(req.request_id)
        fb = sched.feedback(req.request_id, {"actual_production": 120, "on_time": True})
        self.assertEqual(len(req.feedback_records), 1)
        self.assertEqual(fb["actual_outcome"]["actual_production"], 120)
        self.assertEqual(req.feedback_records[0]["actual_outcome"]["on_time"], True)

    def test_reject_sets_rejected(self):
        sched = Scheduler(self._constraints())
        req = self._propose(sched)
        rec = sched.reject(req.request_id, "leader1", "负荷过高")
        self.assertEqual(req.status, REJECTED)
        self.assertEqual(rec["reason"], "负荷过高")
        # 否决后执行仍被拒绝
        self.assertFalse(sched.execute(req.request_id)["executed"])
        self.assertEqual(req.status, REJECTED)

    def test_promote_to_proposed(self):
        sched = Scheduler(self._constraints())
        req = self._propose(sched)
        sched.promote_to_proposed(req.request_id)
        self.assertEqual(req.status, PROPOSED)
        # PROPOSED 状态执行仍被拒绝（未确认）
        self.assertFalse(sched.execute(req.request_id)["executed"])
        self.assertEqual(req.status, PROPOSED)
        # 非 SHADOW 不能再次 promote
        with self.assertRaises(ValueError):
            sched.promote_to_proposed(req.request_id)


# ---------- 安全不变量：无任何自动执行旁路 ----------
class SafetyInvariantTest(unittest.TestCase):
    def test_no_auto_execute_without_confirm_across_states(self):
        sched = Scheduler(HardConstraints(skills_registry={"p1": {"lifting"}}))
        task = {"task_id": "t1", "required_skills": {"lifting"}, "station_id": "s1"}
        persons = [{"person_id": "p1"}]
        devices = [{"device_id": "d1", "model": "exoA"}]

        # SHADOW → 拒绝
        r1 = sched.propose(task, persons, devices, {})
        self.assertEqual(r1.status, SHADOW)
        self.assertFalse(sched.execute(r1.request_id)["executed"])
        self.assertEqual(r1.status, SHADOW)

        # PROPOSED → 仍拒绝
        sched.promote_to_proposed(r1.request_id)
        self.assertFalse(sched.execute(r1.request_id)["executed"])
        self.assertEqual(r1.status, PROPOSED)

        # REJECTED → 仍拒绝
        r2 = sched.propose(task, persons, devices, {})
        sched.reject(r2.request_id, "leader", "否决")
        self.assertFalse(sched.execute(r2.request_id)["executed"])
        self.assertEqual(r2.status, REJECTED)

        # 仅 CONFIRMED → 可执行
        r3 = sched.propose(task, persons, devices, {})
        sched.confirm(r3.request_id, "plan-x", "leader", "确认执行")
        self.assertTrue(sched.execute(r3.request_id)["executed"])
        self.assertEqual(r3.status, EXECUTED)

        # 已 EXECUTED 再次 execute 也应被拒（不可重复自动执行）
        again = sched.execute(r3.request_id)
        self.assertFalse(again["executed"])
        self.assertEqual(r3.status, EXECUTED)


if __name__ == "__main__":
    unittest.main()
