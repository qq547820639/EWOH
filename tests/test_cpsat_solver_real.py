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
        # 同一人员 no-overlap：t1 与 t2 若同用 p1 必须串行
        if by_task["t2"].personId == "p1":
            self.assertLessEqual(by_task["t1"].endMs, by_task["t2"].startMs)

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


if __name__ == "__main__":
    unittest.main()
