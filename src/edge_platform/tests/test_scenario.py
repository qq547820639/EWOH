"""场景仿真层单元测试：指标计算 / 多方案生成 / 方案对比 / 表格输出。

覆盖 spec「场景仿真层」与「方案对比」场景验收要求：
- compute_metrics：高负荷人员与低电量/故障设备正确识别；受影响人员、拥堵变化、产量公式正确。
- ScenarioSimulator.generate_plans：>=3 个方案、类型互异；
  CAPACITY_FIRST 产量 >= SAFETY_BALANCED；SAFETY_BALANCED 高负荷人员 <= CAPACITY_FIRST
  （权衡可见：产能优先产量高但高负荷人员多，负荷均衡反之）。
- compare：指标表每指标一行、各指标最优方案正确、推荐理由非空且引用真实数值。
- format_comparison_table：表格提及每个方案。

纯 Python 标准库 unittest；运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_scenario -v
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.spatial import Pose
from edge_platform.scenario import (
    PlanMetrics, compute_metrics,
    PlanType, Plan, ScenarioSimulator,
    PlanComparison, compare, format_comparison_table,
)


def _ctx():
    """构造测试上下文：3 人 / 3 工位 / 4 设备（含低电量与故障）/ 3 任务。

    当前分配刻意让快人员 p1 在低产出工位 s3，使 CAPACITY_FIRST 与 KEEP_CURRENT 产量不同。
    """
    return {
        "persons_state": {
            # p1 速度最快但当前负荷高；p3 速度最慢，当前负荷 0.65（在 t1 上 0.65+0.2=0.85 超阈值）
            "p1": {"pose": Pose(x=0.0, y=0.0), "current_load": 0.7, "speed_factor": 1.5},
            "p2": {"pose": Pose(x=1.0, y=0.0), "current_load": 0.3, "speed_factor": 1.0},
            "p3": {"pose": Pose(x=2.0, y=0.0), "current_load": 0.65, "speed_factor": 0.8},
        },
        "stations_state": {
            "s1": {"pose": Pose(x=10.0, y=0.0), "capacity": 2,
                   "current_occupancy": 1, "task_id": "t1"},
            "s2": {"pose": Pose(x=0.0, y=10.0), "capacity": 2,
                   "current_occupancy": 1, "task_id": "t2"},
            "s3": {"pose": Pose(x=2.0, y=0.0), "capacity": 2,
                   "current_occupancy": 1, "task_id": "t3"},
        },
        "devices_state": {
            "d1": {"battery_pct": 0.9, "drain_per_hour": 0.05, "faulty": False, "model": "exoA"},
            "d2": {"battery_pct": 0.1, "drain_per_hour": 0.05, "faulty": False, "model": "exoA"},  # 低电量
            "d3": {"battery_pct": 1.0, "drain_per_hour": 0.0, "faulty": True, "model": "exoA"},    # 故障
            "d4": {"battery_pct": 1.0, "drain_per_hour": 0.02, "faulty": False, "model": "exoA"},   # 健康
        },
        "tasks_state": {
            "t1": {"predicted_duration_min": 30, "available_time_min": 25,
                   "expected_units": 20, "load_add": 0.2},
            "t2": {"predicted_duration_min": 20, "available_time_min": 25,
                   "expected_units": 15, "load_add": 0.15},
            "t3": {"predicted_duration_min": 15, "available_time_min": 25,
                   "expected_units": 10, "load_add": 0.1},
        },
        "shift": {
            "remaining_hours": 4.0,
            "battery_low_threshold": 0.2,
            "load_high_threshold": 0.8,
        },
        # 当前分配：快人员 p1 在低产出工位 s3，慢人员 p3 在高产出工位 s1（次优，留出产能提升空间）
        "current_assignment": {
            "p1": {"station_id": "s3", "task_id": "t3", "device_id": "d1"},
            "p2": {"station_id": "s2", "task_id": "t2", "device_id": "d2"},
            "p3": {"station_id": "s1", "task_id": "t1", "device_id": "d1"},
        },
    }


# ---------- 指标计算 ----------
class ComputeMetricsTest(unittest.TestCase):
    def test_high_load_and_low_battery_identified(self):
        ctx = _ctx()
        # p1 当前负荷 0.7 + t1 负荷增量 0.2 = 0.9 > 0.8 → 高负荷
        # d3 故障 → 低电量风险；d2 预测电量 -0.1 < 0.2 → 低电量风险
        assignment = {
            "p1": {"station_id": "s1", "task_id": "t1", "device_id": "d3"},
            "p2": {"station_id": "s2", "task_id": "t2", "device_id": "d2"},
        }
        m = compute_metrics(assignment, ctx)
        self.assertIsInstance(m, PlanMetrics)
        self.assertIn("p1", m.high_load_persons)
        self.assertNotIn("p2", m.high_load_persons)  # p2: 0.3 + 0.15 = 0.45
        self.assertIn("d2", m.low_battery_devices)
        self.assertIn("d3", m.low_battery_devices)   # 故障设备
        # 产量 = 20*1.5 + 15*1.0 = 45
        self.assertAlmostEqual(m.estimated_output, 45.0, places=6)
        # 行走距离 > 0（复用 spatial.distance）
        self.assertGreater(m.total_travel_distance_m, 0.0)
        # delay_risk 在 [0,1]
        self.assertGreaterEqual(m.delay_risk, 0.0)
        self.assertLessEqual(m.delay_risk, 1.0)
        # 关键假设非空且为中文
        self.assertTrue(m.key_assumptions)
        self.assertIn("产量公式", m.key_assumptions)

    def test_affected_persons_when_assignment_changes(self):
        ctx = _ctx()
        # p1 当前在 s3/t3，改到 s2/t2 → 受影响
        assignment = {
            "p1": {"station_id": "s2", "task_id": "t2", "device_id": "d1"},
            "p2": {"station_id": "s2", "task_id": "t2", "device_id": "d2"},
            "p3": {"station_id": "s1", "task_id": "t1", "device_id": "d1"},
        }
        m = compute_metrics(assignment, ctx)
        self.assertIn("p1", m.affected_persons)
        # p3 与当前一致 → 不受影响
        self.assertNotIn("p3", m.affected_persons)

    def test_congestion_delta(self):
        ctx = _ctx()
        # 3 人全部集中到 s1：s1 新占用 3，当前占用 1 → congestion_delta = 2
        assignment = {
            "p1": {"station_id": "s1", "task_id": "t1", "device_id": "d1"},
            "p2": {"station_id": "s1", "task_id": "t1", "device_id": "d2"},
            "p3": {"station_id": "s1", "task_id": "t1", "device_id": "d4"},
        }
        m = compute_metrics(assignment, ctx)
        self.assertAlmostEqual(m.congestion_delta, 2.0, places=6)

    def test_delay_risk_increases_when_predicted_exceeds_available(self):
        ctx = _ctx()
        # p3 速度 0.8 接 t1（预测 30/0.8=37.5 > 可用 25）→ 有延误风险
        assignment = {
            "p3": {"station_id": "s1", "task_id": "t1", "device_id": "d1"},
        }
        m = compute_metrics(assignment, ctx)
        self.assertGreater(m.delay_risk, 0.0)
        # 准时率 < 1
        self.assertLess(m.on_time_probability, 1.0)


# ---------- 多方案生成 ----------
class ScenarioSimulatorTest(unittest.TestCase):
    def test_generate_plans_default_three_distinct_types(self):
        sim = ScenarioSimulator()
        plans = sim.generate_plans(None, _ctx())
        self.assertGreaterEqual(len(plans), 3)
        types = [p.plan_type for p in plans]
        self.assertEqual(len(set(types)), len(types))  # 类型互异
        self.assertIn(PlanType.KEEP_CURRENT.value, types)
        self.assertIn(PlanType.CAPACITY_FIRST.value, types)
        self.assertIn(PlanType.SAFETY_BALANCED.value, types)

    def test_capacity_vs_safety_tradeoff(self):
        sim = ScenarioSimulator()
        plans = sim.generate_plans(None, _ctx())
        by_type = {p.plan_type: p for p in plans}
        cap = by_type[PlanType.CAPACITY_FIRST.value]
        safe = by_type[PlanType.SAFETY_BALANCED.value]
        # CAPACITY_FIRST 产量 >= SAFETY_BALANCED（产能优先打包到快人员）
        self.assertGreaterEqual(
            cap.metrics.estimated_output,
            safe.metrics.estimated_output - 1e-9)
        # SAFETY_BALANCED 高负荷人员数 <= CAPACITY_FIRST（负荷均衡不超阈值）
        self.assertLessEqual(
            len(safe.metrics.high_load_persons),
            len(cap.metrics.high_load_persons))
        # 权衡必须可见：产能优先至少 1 个高负荷人员，负荷均衡为 0
        self.assertGreaterEqual(len(cap.metrics.high_load_persons), 1)
        self.assertEqual(len(safe.metrics.high_load_persons), 0)

    def test_all_five_types_supported(self):
        sim = ScenarioSimulator()
        plans = sim.generate_plans(None, _ctx(), types=list(PlanType))
        self.assertEqual(len(plans), 5)
        types = {p.plan_type for p in plans}
        self.assertEqual(types, {t.value for t in PlanType})

    def test_each_plan_has_rationale_and_metrics(self):
        sim = ScenarioSimulator()
        plans = sim.generate_plans(None, _ctx())
        for p in plans:
            self.assertIsInstance(p, Plan)
            self.assertIsInstance(p.metrics, PlanMetrics)
            self.assertTrue(p.rationale)
            # 中文理由
            self.assertTrue(any("\u4e00" <= ch <= "\u9fff" for ch in p.rationale))
            self.assertGreaterEqual(p.confidence, 0.0)
            self.assertLessEqual(p.confidence, 1.0)
            self.assertTrue(p.plan_id.startswith("PLAN-"))

    def test_equipment_emergency_reassigns_faulty_device(self):
        sim = ScenarioSimulator()
        ctx = _ctx()
        # 当前 p2 使用低电量设备 d2，p1/p3 使用 d1（健康）
        plans = sim.generate_plans(None, ctx, types=[PlanType.EQUIPMENT_EMERGENCY])
        self.assertEqual(len(plans), 1)
        plan = plans[0]
        # 应急方案不应再分配故障/低电量设备给原人员
        for pid, a in plan.assignment.items():
            self.assertNotEqual(a["device_id"], "d3")  # 故障设备 d3 不应被分配
            # 原 d2 使用者应被换到健康设备
            if pid == "p2":
                self.assertNotEqual(a["device_id"], "d2")

    def test_accepts_duck_typed_schedule_request(self):
        """schedule_request 可为 dict（duck-typed），不报错。"""
        sim = ScenarioSimulator()
        req = {"trigger": {"reason": "bottleneck"}, "task": {"task_id": "t1"}}
        plans = sim.generate_plans(req, _ctx())
        self.assertGreaterEqual(len(plans), 3)


# ---------- 方案对比 ----------
class CompareTest(unittest.TestCase):
    def test_metric_table_has_row_per_metric(self):
        sim = ScenarioSimulator()
        plans = sim.generate_plans(None, _ctx())
        comp = compare(plans)
        self.assertIsInstance(comp, PlanComparison)
        metric_keys = [row["metric_key"] for row in comp.metric_table]
        for expected in ["estimated_output", "on_time_probability", "delay_risk",
                         "high_load_persons_count", "total_travel_distance_m",
                         "low_battery_devices_count", "congestion_delta", "confidence"]:
            self.assertIn(expected, metric_keys)
        # 每行包含每个方案的值
        plan_ids = {p.plan_id for p in plans}
        for row in comp.metric_table:
            for pid in plan_ids:
                self.assertIn(pid, row)

    def test_winner_by_metric_correct(self):
        sim = ScenarioSimulator()
        plans = sim.generate_plans(None, _ctx())
        comp = compare(plans)
        plan_ids = {p.plan_id for p in plans}
        # 每个 winner 指向某个方案
        for key, winner in comp.winner_by_metric.items():
            self.assertIn(winner, plan_ids)
        # 产量最优 = CAPACITY_FIRST（产能优先打包到快人员）
        cap_id = next(p.plan_id for p in plans
                      if p.plan_type == PlanType.CAPACITY_FIRST.value)
        self.assertEqual(comp.winner_by_metric["estimated_output"], cap_id)
        # 高负荷人员数最优 = SAFETY_BALANCED（0 人）
        safe_id = next(p.plan_id for p in plans
                       if p.plan_type == PlanType.SAFETY_BALANCED.value)
        self.assertEqual(comp.winner_by_metric["high_load_persons_count"], safe_id)

    def test_recommendation_nonempty_with_real_numbers(self):
        sim = ScenarioSimulator()
        plans = sim.generate_plans(None, _ctx())
        comp = compare(plans)
        self.assertTrue(comp.recommendation)
        # 引用真实数值与方案名（spec section 7.5 示例口径）
        self.assertIn("产能优先", comp.recommendation)
        self.assertIn("负荷均衡", comp.recommendation)
        self.assertIn("高负荷人员", comp.recommendation)
        self.assertIn("低电量风险", comp.recommendation)
        # 引用具体数字（节拍提升百分比或人数）
        self.assertRegex(comp.recommendation, r"\d")
        # 引用节拍提升口径
        self.assertIn("节拍提升", comp.recommendation)

    def test_recommendation_references_computed_values(self):
        """推荐理由中的数字与方案指标真实值一致。"""
        sim = ScenarioSimulator()
        plans = sim.generate_plans(None, _ctx())
        comp = compare(plans)
        cap = next(p for p in plans if p.plan_type == PlanType.CAPACITY_FIRST.value)
        # 产能优先方案的高负荷人数出现在理由中
        self.assertIn(str(len(cap.metrics.high_load_persons)),
                      comp.recommendation)


# ---------- 表格输出 ----------
class FormatTableTest(unittest.TestCase):
    def test_table_mentions_each_plan(self):
        sim = ScenarioSimulator()
        plans = sim.generate_plans(None, _ctx())
        comp = compare(plans)
        table = format_comparison_table(comp)
        self.assertIsInstance(table, str)
        # 表格按类型提及每个方案
        for p in plans:
            self.assertIn(p.plan_type, table)
        # 含 Markdown 表头分隔与推荐
        self.assertIn("|", table)
        self.assertIn("---", table)
        self.assertIn("推荐", table)
        # 含各指标中文名
        self.assertIn("预计产量", table)
        self.assertIn("高负荷人员数", table)

    def test_empty_comparison_returns_placeholder(self):
        table = format_comparison_table(PlanComparison())
        self.assertIn("无方案", table)


if __name__ == "__main__":
    unittest.main()
