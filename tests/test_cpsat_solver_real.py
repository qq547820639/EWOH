"""CP-SAT 真实求解 fixture 测试（A2 修复回归）。

背景：A2 验证发现 `_solve_cpsat` 目标函数缺少"未分配惩罚"——
最小化目标的最优解 = 全部留空（presence 全 0，objective=0），
部署后即使 solverStatus=OPTIMAL 也零派工（模块"可用"但空转）。

本测试在 ortools 可用时验证真实求解路径（ortools 缺失自动 skip，
与 solver.py 的依赖探测一致）：
1. 能力/技能满足时 → 全部任务被分配（unassigned=0）；
2. 能力不匹配 → 对应任务如实未分配（不冒充成功）；
3. 资源 no-overlap 生效（同一人员串行）。

运行：PYTHONPATH=src python -m pytest tests/test_cpsat_solver_real.py -q
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

try:  # noqa: E402
    import ortools  # noqa: F401

    _ORT_TOOLS_AVAILABLE = True
except Exception:  # noqa: BLE001 - 与 solver.py 的依赖探测一致
    _ORT_TOOLS_AVAILABLE = False

from edge_platform.scheduler.cpsat.contract import SolverRequest  # noqa: E402
from edge_platform.scheduler.cpsat.solver import solve  # noqa: E402


def _make_req(tasks, persons, devices, stations, weights=None):
    return SolverRequest.from_dict(
        {
            "requestId": "fixture-1",
            "snapshotVersion": "WS-FIXTURE",
            "policyVersion": 1,
            "solverVersion": "cpsat-v1",
            "horizonMinutes": 120,
            "nowMs": 0,
            "weights": weights or {
                "lateness": 1.0,
                "travel": 1.0,
                "workloadBalance": 1.0,
                "stationWait": 1.0,
                "changeCost": 0.5,
                "energyRisk": 1.0,
            },
            "tasks": tasks,
            "persons": persons,
            "devices": devices,
            "stations": stations,
            "reservations": [],
            "forbiddenZones": [],
            "frozenAssignments": [],
            "baselineAssignee": {},
            "timeLimitMs": 3000,
        }
    )


@unittest.skipUnless(_ORT_TOOLS_AVAILABLE, "ortools 未安装，跳过真实求解 fixture 测试")
class CpSatRealSolverFixtureTest(unittest.TestCase):
    def test_all_assignable_tasks_are_assigned(self):
        """能力/技能满足 → 全部任务分配（A2 修复核心回归）。"""
        req = _make_req(
            tasks=[
                {
                    "taskId": "t1",
                    "priority": 1.0,
                    "earliestStartMs": 0,
                    "dueMs": None,
                    "durationMs": 30_000,
                    "requiredSkills": ["lift"],
                    "requiredDeviceCapabilities": ["exo-lift"],
                    "candidateStationIds": ["st1"],
                },
                {
                    "taskId": "t2",
                    "priority": 0.5,
                    "earliestStartMs": 0,
                    "dueMs": None,
                    "durationMs": 20_000,
                    "requiredSkills": [],
                    "candidateStationIds": ["st1"],
                },
            ],
            persons=[
                {"id": "p1", "status": "available", "locationStationId": "st1", "x": 0, "y": 0, "skills": ["lift"]},
                {"id": "p2", "status": "available", "locationStationId": "st1", "x": 10, "y": 0, "skills": []},
            ],
            devices=[
                {"id": "d1", "status": "available", "online": True, "capabilities": ["exo-lift"], "batteryPct": 90.0},
            ],
            stations=[{"id": "st1", "x": 0, "y": 0, "capacity": 5}],
        )
        resp = solve(req)
        self.assertEqual(resp.solverStatus, "OPTIMAL")
        self.assertEqual(len(resp.hardViolations), 0)
        self.assertEqual(resp.unassignedTaskIds, [], "可分配任务必须全部分配（未分配惩罚生效）")
        self.assertEqual(len(resp.assignments), 2)
        by_task = {a.taskId: a for a in resp.assignments}
        self.assertEqual(by_task["t1"].personId, "p1")  # t1 需要 lift 技能 → p1
        self.assertEqual(by_task["t1"].deviceId, "d1")  # t1 需要 exo-lift → d1
        # 同一人员 no-overlap：t1 与 t2 若同用 p1 必须串行（顺序不定——求解器
        # 可任意选择 t1/t2 谁先谁后，二者目标等价；只断言不重叠）。
        if by_task["t2"].personId == "p1":
            self.assertTrue(
                by_task["t1"].endMs <= by_task["t2"].startMs
                or by_task["t2"].endMs <= by_task["t1"].startMs,
                "同一人员 no-overlap：t1 与 t2 不得时间重叠",
            )

    def test_capability_mismatch_task_unassigned(self):
        """能力不匹配 → 该任务如实未分配（不冒充成功）。"""
        req = _make_req(
            tasks=[
                {
                    "taskId": "t-x",
                    "priority": 1.0,
                    "earliestStartMs": 0,
                    "dueMs": None,
                    "durationMs": 30_000,
                    "requiredSkills": ["heavy_lift"],
                    "requiredDeviceCapabilities": ["exo-heavy"],
                    "candidateStationIds": ["st1"],
                }
            ],
            persons=[
                {"id": "p1", "status": "available", "locationStationId": "st1", "x": 0, "y": 0, "skills": ["lift"]},
            ],
            devices=[
                {"id": "d1", "status": "available", "online": True, "capabilities": ["exo-lift"], "batteryPct": 90.0},
            ],
            stations=[{"id": "st1", "x": 0, "y": 0, "capacity": 5}],
        )
        resp = solve(req)
        self.assertIn(resp.solverStatus, ("OPTIMAL", "FEASIBLE"))
        self.assertEqual(resp.unassignedTaskIds, ["t-x"], "能力不匹配的任务必须如实未分配")


@unittest.skipUnless(_ORT_TOOLS_AVAILABLE, "ortools 未安装，跳过真实求解 fixture 测试")
class CpSatHorizonDueBoundsTest(unittest.TestCase):
    """F-HORIZON 回归（2026-08-09）：horizon/due 边界约束仅当任务被分配时生效。

    此前约束 3b（end <= horizon_min）与约束 3（end <= due）无条件生效：earliestStart
    在视野外 / lo+dur>horizon / 无法满足 due 的非冻结任务会让**整个模型 INFEASIBLE**
    （视野内任务也被连坐），生产上 DB 中任一 planStart 超出 horizon 的任务都会禁用
    CP-SAT。修复后这类任务应如实进入 unassigned，而不是崩掉全局求解。
    """

    def _req(self, tasks, persons=None, devices=None, stations=None):
        return _make_req(
            tasks=tasks,
            persons=persons or [
                {"id": "p1", "status": "available", "locationStationId": "st1", "x": 0, "y": 0, "skills": []},
            ],
            devices=devices or [],
            stations=stations or [{"id": "st1", "x": 0, "y": 0, "capacity": 5}],
        )

    def test_earliest_start_beyond_horizon_unassigned(self):
        """earliestStartMs=121min（视野外 120min），时长 30min → 如实未分配，不 INFEASIBLE。"""
        resp = solve(
            self._req(
                [
                    {
                        "taskId": "t1",
                        "priority": 1.0,
                        "earliestStartMs": 121 * 60_000,
                        "dueMs": None,
                        "durationMs": 30 * 60_000,
                        "requiredSkills": [],
                        "candidateStationIds": ["st1"],
                    }
                ]
            )
        )
        self.assertIn(resp.solverStatus, ("OPTIMAL", "FEASIBLE"))
        self.assertEqual(resp.unassignedTaskIds, ["t1"], "视野外任务必须如实未分配（不得 INFEASIBLE）")
        self.assertEqual(resp.assignments, [])

    def test_inside_horizon_but_does_not_fit_unassigned(self):
        """earliestStartMs=110min + 30min 时长（110+30>120，视野内但放不下）→ 如实未分配。"""
        resp = solve(
            self._req(
                [
                    {
                        "taskId": "t1",
                        "priority": 1.0,
                        "earliestStartMs": 110 * 60_000,
                        "dueMs": None,
                        "durationMs": 30 * 60_000,
                        "requiredSkills": [],
                        "candidateStationIds": ["st1"],
                    }
                ]
            )
        )
        self.assertIn(resp.solverStatus, ("OPTIMAL", "FEASIBLE"))
        self.assertEqual(resp.unassignedTaskIds, ["t1"], "放不下的任务必须如实未分配（不得 INFEASIBLE）")

    def test_mixed_in_and_out_horizon_no_collateral(self):
        """混合：t1 视野内可分配 + t2 视野外 → OPTIMAL，t1 分配且 t2 未分配（不连坐）。"""
        resp = solve(
            self._req(
                [
                    {
                        "taskId": "t1",
                        "priority": 1.0,
                        "earliestStartMs": 0,
                        "dueMs": None,
                        "durationMs": 30_000,
                        "requiredSkills": [],
                        "candidateStationIds": ["st1"],
                    },
                    {
                        "taskId": "t2",
                        "priority": 1.0,
                        "earliestStartMs": 121 * 60_000,
                        "dueMs": None,
                        "durationMs": 30 * 60_000,
                        "requiredSkills": [],
                        "candidateStationIds": ["st1"],
                    },
                ]
            )
        )
        self.assertIn(resp.solverStatus, ("OPTIMAL", "FEASIBLE"))
        self.assertEqual(resp.unassignedTaskIds, ["t2"], "视野外任务未分配")
        self.assertEqual(len(resp.assignments), 1, "视野内任务必须正常分配（不被连坐）")
        self.assertEqual(resp.assignments[0].taskId, "t1")
        self.assertEqual(resp.assignments[0].personId, "p1")

    def test_due_cannot_be_met_unassigned(self):
        """due 场景（同族）：时长 30min 但 due=10min → 如实未分配，不 INFEASIBLE。"""
        resp = solve(
            self._req(
                [
                    {
                        "taskId": "t1",
                        "priority": 1.0,
                        "earliestStartMs": 0,
                        "dueMs": 10 * 60_000,
                        "durationMs": 30 * 60_000,
                        "requiredSkills": [],
                        "candidateStationIds": ["st1"],
                    }
                ]
            )
        )
        self.assertIn(resp.solverStatus, ("OPTIMAL", "FEASIBLE"))
        self.assertEqual(resp.unassignedTaskIds, ["t1"], "无法满足 due 的任务必须如实未分配（不得 INFEASIBLE）")


if __name__ == "__main__":
    unittest.main()
