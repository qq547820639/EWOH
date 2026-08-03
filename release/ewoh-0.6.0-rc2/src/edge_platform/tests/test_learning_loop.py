"""学习闭环单元测试：执行结果回流 → 偏差统计 → 参数校准建议。

覆盖 spec Task 31「学习闭环（能学习）」与 checklist 验收：
- record_outcome 正确计算 metric_deltas（actual - predicted）与改善判定
  （产量提升 OR 负荷降低至少一项）；
- compute_stats 采纳率（adopted / proposed）、改善率（adopted_with_improvement /
  adopted_count）与达标判定（adoption_rate >= 0.30 且 improvement_rate > 0）；
- suggest_calibrations 基于平均偏差产出校准建议，applied=False 不自动应用，
  且不修改 Scheduler 权重（权重变更走 WeightAuditLog）；
- export_period_report 输出 stats + calibrations + top_deviation_cases 完整报告。

纯 Python 标准库 unittest；运行：PYTHONPATH=src python -m unittest edge_platform.tests.test_learning_loop -v
亦可：python -m pytest src/edge_platform/tests/test_learning_loop.py -v
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.scheduler import (
    EXECUTED,
    CalibrationSuggestion,
    HardConstraints,
    LearningLoop,
    LearningStats,
    ScheduleOutcome,
    Scheduler,
)
from edge_platform.spatial import Pose


class _LearningLoopTestBase(unittest.TestCase):
    """构造调度请求的公共脚手架。"""

    def _make_scheduler(self):
        constraints = HardConstraints(
            skills_registry={"p1": {"lifting"}},
            station_auth={"p1": {"s1"}},
        )
        return Scheduler(constraints)

    def _propose_raw(self, sched, production_uplift=0.5, current_load=0.4):
        task = {"task_id": "t1", "required_skills": {"lifting"}, "station_id": "s1", "zone_id": "z1"}
        persons = [{"person_id": "p1"}]
        devices = [{"device_id": "d1", "model": "exoA"}]
        ctx = {
            "persons_state": {
                "p1": {
                    "current_load": current_load,
                    "expected_production_uplift": production_uplift,
                    "on_time_probability": 0.8,
                    "pose": Pose(x=0.0, y=0.0),
                },
            },
            "stations_state": {"s1": {"pose": Pose(x=3.0, y=4.0)}},
        }
        return sched.propose(task, persons, devices, ctx)

    def _adopted(self, loop, sched, actual_production, actual_body_load, production_uplift=0.5, current_load=0.4):
        """propose → confirm(真实 candidate_id) → execute → feedback → record_outcome。"""
        req = self._propose_raw(sched, production_uplift, current_load)
        plan_id = req.candidates[0].candidate_id
        sched.confirm(req.request_id, plan_id, "leader1", "综合最优")
        sched.execute(req.request_id)
        sched.feedback(
            req.request_id,
            {
                "production": actual_production,
                "body_load": actual_body_load,
            },
        )
        return loop.record_outcome(req.request_id)

    def _proposed_only(self, loop, sched, **kw):
        req = self._propose_raw(sched, **kw)
        sched.promote_to_proposed(req.request_id)
        return loop.record_outcome(req.request_id)

    def _rejected(self, loop, sched, **kw):
        req = self._propose_raw(sched, **kw)
        sched.reject(req.request_id, "leader1", "负荷过高")
        return loop.record_outcome(req.request_id)


# ---------- record_outcome：偏差与改善判定 ----------
class RecordOutcomeTest(_LearningLoopTestBase):
    def test_record_outcome_metric_deltas(self):
        """actual - predicted 的差值正确计算。"""
        sched = self._make_scheduler()
        loop = LearningLoop(sched)
        # predicted: production=0.5, body_load=0.4
        o = self._adopted(loop, sched, actual_production=0.7, actual_body_load=0.3)
        self.assertIsInstance(o, ScheduleOutcome)
        self.assertAlmostEqual(o.predicted_metrics["production"], 0.5, places=9)
        self.assertAlmostEqual(o.predicted_metrics["body_load"], 0.4, places=9)
        self.assertAlmostEqual(o.actual_metrics["production"], 0.7, places=9)
        self.assertAlmostEqual(o.actual_metrics["body_load"], 0.3, places=9)
        self.assertAlmostEqual(o.metric_deltas["production"], 0.2, places=9)
        self.assertAlmostEqual(o.metric_deltas["body_load"], -0.1, places=9)

    def test_record_outcome_improved_by_production(self):
        """产量提升达标（actual.production >= predicted.production）→ improved=True。"""
        sched = self._make_scheduler()
        loop = LearningLoop(sched)
        # production 0.6 >= 0.5 提升；body_load 0.5 > 0.4 未改善
        o = self._adopted(loop, sched, actual_production=0.6, actual_body_load=0.5)
        self.assertTrue(o.improved)

    def test_record_outcome_improved_by_body_load(self):
        """负荷降低达标（actual.body_load <= predicted.body_load）→ improved=True。"""
        sched = self._make_scheduler()
        loop = LearningLoop(sched)
        # production 0.4 < 0.5 未改善；body_load 0.3 <= 0.4 改善
        o = self._adopted(loop, sched, actual_production=0.4, actual_body_load=0.3)
        self.assertTrue(o.improved)

    def test_record_outcome_no_improvement(self):
        """两项指标均未改善 → improved=False。"""
        sched = self._make_scheduler()
        loop = LearningLoop(sched)
        # production 0.4 < 0.5；body_load 0.5 > 0.4
        o = self._adopted(loop, sched, actual_production=0.4, actual_body_load=0.5)
        self.assertFalse(o.improved)

    def test_record_outcome_predicted_from_confirmed_candidate(self):
        """predicted_metrics 取自 confirmed_plan_id 对应候选的 score_breakdown。"""
        sched = self._make_scheduler()
        loop = LearningLoop(sched)
        req = self._propose_raw(sched, production_uplift=0.8, current_load=0.3)
        plan_id = req.candidates[0].candidate_id
        sched.confirm(req.request_id, plan_id, "leader1", "确认")
        sched.execute(req.request_id)
        sched.feedback(req.request_id, {"production": 0.5, "body_load": 0.5})
        o = loop.record_outcome(req.request_id)
        # plan_id 与 confirmed_plan_id 一致
        self.assertEqual(o.plan_id, plan_id)
        # predicted 取自候选 score_breakdown
        self.assertAlmostEqual(o.predicted_metrics["production"], 0.8, places=9)
        self.assertAlmostEqual(o.predicted_metrics["body_load"], 0.3, places=9)
        self.assertTrue(o.was_adopted)
        self.assertEqual(o.status, EXECUTED)

    def test_record_outcome_non_adopted_has_no_predicted(self):
        """未被采纳（无 confirmed_plan_id）→ predicted 为空、improved=None。"""
        sched = self._make_scheduler()
        loop = LearningLoop(sched)
        o = self._proposed_only(loop, sched)
        self.assertFalse(o.was_adopted)
        self.assertEqual(o.plan_id, "")
        self.assertEqual(o.predicted_metrics, {})
        self.assertIsNone(o.improved)


# ---------- compute_stats：统计与达标判定 ----------
class ComputeStatsTest(_LearningLoopTestBase):
    def test_compute_stats_basic_counts(self):
        """基本计数：total / proposed / adopted / rejected。"""
        sched = self._make_scheduler()
        loop = LearningLoop(sched)
        self._adopted(loop, sched, 0.6, 0.3)  # EXECUTED（采纳）
        self._proposed_only(loop, sched)  # PROPOSED（未采纳）
        self._rejected(loop, sched)  # REJECTED
        stats = loop.compute_stats()
        self.assertIsInstance(stats, LearningStats)
        self.assertEqual(stats.total_requests, 3)
        # 非 SHADOW 计入 proposed
        self.assertEqual(stats.proposed_count, 3)
        self.assertEqual(stats.adopted_count, 1)
        self.assertEqual(stats.rejected_count, 1)

    def test_compute_stats_adoption_rate(self):
        """adoption_rate = adopted_count / proposed_count。"""
        sched = self._make_scheduler()
        loop = LearningLoop(sched)
        # 2 采纳 + 3 仅建议 → 5 proposed，2 adopted → 0.4
        self._adopted(loop, sched, 0.6, 0.3)
        self._adopted(loop, sched, 0.6, 0.3)
        self._proposed_only(loop, sched)
        self._proposed_only(loop, sched)
        self._proposed_only(loop, sched)
        stats = loop.compute_stats()
        self.assertEqual(stats.adopted_count, 2)
        self.assertEqual(stats.proposed_count, 5)
        self.assertAlmostEqual(stats.adoption_rate, 0.4, places=9)

    def test_compute_stats_adoption_meets_target(self):
        """采纳率 >= 0.30 且改善率 > 0 → meets_target=True。"""
        sched = self._make_scheduler()
        loop = LearningLoop(sched)
        # 3 采纳（含改善）+ 7 仅建议 → 0.30 达标
        for _ in range(3):
            self._adopted(loop, sched, 0.6, 0.3)  # improved=True
        for _ in range(7):
            self._proposed_only(loop, sched)
        stats = loop.compute_stats()
        self.assertAlmostEqual(stats.adoption_rate, 0.30, places=9)
        self.assertGreater(stats.improvement_rate_of_adopted, 0.0)
        self.assertTrue(stats.meets_target)

    def test_compute_stats_adoption_below_target(self):
        """采纳率 < 0.30 → meets_target=False。"""
        sched = self._make_scheduler()
        loop = LearningLoop(sched)
        # 2 采纳（均改善）+ 8 仅建议 → 0.2 < 0.30
        for _ in range(2):
            self._adopted(loop, sched, 0.6, 0.3)
        for _ in range(8):
            self._proposed_only(loop, sched)
        stats = loop.compute_stats()
        self.assertAlmostEqual(stats.adoption_rate, 0.2, places=9)
        self.assertFalse(stats.meets_target)

    def test_compute_stats_improvement_rate_of_adopted(self):
        """improvement_rate_of_adopted = adopted_with_improvement / adopted_count。"""
        sched = self._make_scheduler()
        loop = LearningLoop(sched)
        # 3 采纳：2 改善 + 1 未改善 → 2/3
        self._adopted(loop, sched, 0.6, 0.3)  # improved
        self._adopted(loop, sched, 0.6, 0.3)  # improved
        self._adopted(loop, sched, 0.4, 0.5)  # 未改善
        stats = loop.compute_stats()
        self.assertEqual(stats.adopted_count, 3)
        self.assertEqual(stats.adopted_with_improvement, 2)
        self.assertAlmostEqual(stats.improvement_rate_of_adopted, 2.0 / 3.0, places=9)

    def test_compute_stats_meets_target_requires_both_conditions(self):
        """meets_target 需同时满足采纳率达标与改善率 > 0。"""
        # Case A：采纳率达标但改善率为 0 → False
        sched_a = self._make_scheduler()
        loop_a = LearningLoop(sched_a)
        for _ in range(3):
            self._adopted(loop_a, sched_a, 0.4, 0.5)  # 均未改善
        for _ in range(7):
            self._proposed_only(loop_a, sched_a)
        stats_a = loop_a.compute_stats()
        self.assertAlmostEqual(stats_a.adoption_rate, 0.30, places=9)
        self.assertEqual(stats_a.improvement_rate_of_adopted, 0.0)
        self.assertFalse(stats_a.meets_target)

        # Case B：改善率 > 0 但采纳率不达标 → False
        sched_b = self._make_scheduler()
        loop_b = LearningLoop(sched_b)
        self._adopted(loop_b, sched_b, 0.6, 0.3)  # 1 改善
        for _ in range(9):
            self._proposed_only(loop_b, sched_b)
        stats_b = loop_b.compute_stats()
        self.assertAlmostEqual(stats_b.adoption_rate, 0.1, places=9)
        self.assertGreater(stats_b.improvement_rate_of_adopted, 0.0)
        self.assertFalse(stats_b.meets_target)

    def test_compute_stats_period_filtering(self):
        """period_start/period_end 过滤 proposed_at。"""
        sched = self._make_scheduler()
        loop = LearningLoop(sched)
        self._adopted(loop, sched, 0.6, 0.3)
        self._proposed_only(loop, sched)
        # 全包含窗口
        wide = loop.compute_stats(period_start="2000-01-01T00:00:00+00:00", period_end="2099-01-01T00:00:00+00:00")
        self.assertEqual(wide.total_requests, 2)
        # 全排除窗口（早于一切记录）
        empty = loop.compute_stats(period_start="2000-01-01T00:00:00+00:00", period_end="2000-01-02T00:00:00+00:00")
        self.assertEqual(empty.total_requests, 0)
        self.assertEqual(empty.proposed_count, 0)
        self.assertFalse(empty.meets_target)

    def test_compute_stats_avg_metric_deltas(self):
        """avg_metric_deltas 聚合各指标平均偏差。"""
        sched = self._make_scheduler()
        loop = LearningLoop(sched)
        # predicted 0.5/0.4；actual 0.7/0.3 → deltas 0.2/-0.1
        self._adopted(loop, sched, 0.7, 0.3)
        # predicted 0.5/0.4；actual 0.6/0.3 → deltas 0.1/-0.1
        self._adopted(loop, sched, 0.6, 0.3)
        stats = loop.compute_stats()
        self.assertAlmostEqual(stats.avg_metric_deltas["production"], 0.15, places=9)
        self.assertAlmostEqual(stats.avg_metric_deltas["body_load"], -0.1, places=9)


# ---------- suggest_calibrations ----------
class SuggestCalibrationsTest(_LearningLoopTestBase):
    def test_suggest_calibrations_generates(self):
        """产量持续低于预测 → 降 w1_production；负荷持续高于预测 → 升 w4_body_load。"""
        sched = self._make_scheduler()
        loop = LearningLoop(sched)
        # predicted production=0.8, body_load=0.2；actual 0.5/0.6
        # deltas: production=-0.3（低于预测）, body_load=0.4（高于预测）
        self._adopted(loop, sched, actual_production=0.5, actual_body_load=0.6, production_uplift=0.8, current_load=0.2)
        suggestions = loop.suggest_calibrations()
        params = {s.parameter for s in suggestions}
        self.assertIn("w1_production", params)
        self.assertIn("w4_body_load", params)
        w1 = [s for s in suggestions if s.parameter == "w1_production"][0]
        w4 = [s for s in suggestions if s.parameter == "w4_body_load"][0]
        # 默认权重均为 1.0
        self.assertAlmostEqual(w1.current_value, 1.0, places=9)
        self.assertAlmostEqual(w1.suggested_value, 0.9, places=9)
        self.assertLess(w1.suggested_value, w1.current_value)
        self.assertAlmostEqual(w4.current_value, 1.0, places=9)
        self.assertAlmostEqual(w4.suggested_value, 1.1, places=9)
        self.assertGreater(w4.suggested_value, w4.current_value)
        # reason 引用偏差
        self.assertIn("产量", w1.reason)
        self.assertIn("负荷", w4.reason)
        # evidence 含 avg_delta 与 sample_count
        self.assertIn("avg_delta", w1.evidence)
        self.assertIn("sample_count", w1.evidence)
        self.assertIsInstance(w1.confidence, float)
        self.assertGreaterEqual(w1.confidence, 0.0)
        self.assertLessEqual(w1.confidence, 1.0)

    def test_suggest_calibrations_not_applied_and_weights_unchanged(self):
        """建议均 applied=False，且不自动修改 Scheduler 权重（安全不变量）。"""
        sched = self._make_scheduler()
        loop = LearningLoop(sched)
        self._adopted(loop, sched, actual_production=0.5, actual_body_load=0.6, production_uplift=0.8, current_load=0.2)
        suggestions = loop.suggest_calibrations()
        self.assertTrue(suggestions)
        for s in suggestions:
            self.assertIsInstance(s, CalibrationSuggestion)
            self.assertFalse(s.applied)
        # 权重审计日志无新增（学习闭环不调用 set_weights）
        self.assertEqual(sched.audit_log.history(), [])
        # 权重保持默认值未被修改
        self.assertAlmostEqual(sched.scorer.weights.w1_production, 1.0, places=9)
        self.assertAlmostEqual(sched.scorer.weights.w4_body_load, 1.0, places=9)

    def test_suggest_calibrations_no_suggestion_without_deviation(self):
        """无偏差信号（实际优于预测）时不产出校准建议。"""
        sched = self._make_scheduler()
        loop = LearningLoop(sched)
        # production delta > 0（高于预测）, body_load delta < 0（低于预测）→ 无建议
        self._adopted(loop, sched, actual_production=0.7, actual_body_load=0.2, production_uplift=0.5, current_load=0.4)
        suggestions = loop.suggest_calibrations()
        self.assertEqual(suggestions, [])


# ---------- export_period_report ----------
class ExportPeriodReportTest(_LearningLoopTestBase):
    def test_export_period_report_complete(self):
        """周期报告含 stats / calibrations / top_deviation_cases 完整结构。"""
        sched = self._make_scheduler()
        loop = LearningLoop(sched)
        # 制造偏差用例：production 持续低于预测
        self._adopted(loop, sched, actual_production=0.5, actual_body_load=0.6, production_uplift=0.8, current_load=0.2)
        self._adopted(loop, sched, actual_production=0.4, actual_body_load=0.7, production_uplift=0.8, current_load=0.2)
        self._proposed_only(loop, sched)

        report = loop.export_period_report(
            period_start="2000-01-01T00:00:00+00:00",
            period_end="2099-01-01T00:00:00+00:00",
        )
        self.assertIn("period_start", report)
        self.assertIn("period_end", report)
        self.assertIn("stats", report)
        self.assertIn("calibrations", report)
        self.assertIn("top_deviation_cases", report)

        # stats 完整
        stats = report["stats"]
        for key in (
            "total_requests",
            "proposed_count",
            "adopted_count",
            "rejected_count",
            "adoption_rate",
            "adopted_with_improvement",
            "improvement_rate_of_adopted",
            "meets_target",
            "avg_metric_deltas",
            "period_start",
            "period_end",
        ):
            self.assertIn(key, stats)
        self.assertEqual(stats["total_requests"], 3)
        self.assertEqual(stats["adopted_count"], 2)

        # calibrations 为 dict 列表，均 applied=False
        self.assertIsInstance(report["calibrations"], list)
        self.assertTrue(report["calibrations"])
        for c in report["calibrations"]:
            self.assertFalse(c["applied"])
            self.assertIn("parameter", c)
            self.assertIn("current_value", c)
            self.assertIn("suggested_value", c)
            self.assertIn("reason", c)

        # top_deviation_cases 按最大 |delta| 降序，取前 5
        cases = report["top_deviation_cases"]
        self.assertIsInstance(cases, list)
        self.assertLessEqual(len(cases), 5)
        if len(cases) >= 2:
            dev0 = max(abs(v) for v in cases[0]["metric_deltas"].values())
            dev1 = max(abs(v) for v in cases[1]["metric_deltas"].values())
            self.assertGreaterEqual(dev0, dev1)
        # 偏差最大的用例排在首位（body_load 偏差 0.5 的那条）
        self.assertTrue(cases)
        self.assertEqual(cases[0]["status"], EXECUTED)


if __name__ == "__main__":
    unittest.main()
