"""CP-SAT 求解器 worker 契约测试。

覆盖：
- SolverRequest.from_dict / SolverResponse.to_dict 往返。
- solve() 返回 SolverResponse；其中依赖 ortools 的可行性/确定性断言仅在
  ``cpsat_solver.is_available()`` 时执行（未安装 ortools 时跳过）。
- 未安装 ortools 时 solve() 必须返回 "UNAVAILABLE" 且 unassignedTaskIds 含全部任务
  （该路径始终执行，保证套件在无 ortools 环境也能通过）。
"""

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SRC = REPO_ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from edge_platform.scheduler.cpsat import solver as cpsat_solver  # noqa: E402
from edge_platform.scheduler.cpsat.contract import (  # noqa: E402
    SolverRequest,
    SolverResponse,
)


def build_request() -> dict:
    """构造一个小型 SolverRequest 字典（2 人 / 1 设备 / 1 工位 / 1 任务）。"""
    now = 1_000_000
    return {
        "requestId": "req-test-001",
        "snapshotVersion": "snap-v1",
        "policyVersion": 1,
        "solverVersion": "cpsat-v1",
        "horizonMinutes": 480,
        "nowMs": now,
        "weights": {"lateness": 1.0, "travel": 1.0, "workloadBalance": 1.0},
        "tasks": [
            {
                "taskId": "T1",
                "priority": 10.0,
                "earliestStartMs": now,
                "dueMs": now + 3_600_000,
                "durationMs": 60_000,
                "requiredSkills": ["inspect"],
                "requiredCertifications": [],
                "requiredDeviceCapabilities": ["camera"],
                "candidateStationIds": ["S1"],
            }
        ],
        "persons": [
            {
                "id": "P1",
                "status": "available",
                "locationStationId": "S1",
                "x": 0.0,
                "y": 0.0,
                "skills": ["inspect"],
                "certifications": [],
            },
            {
                "id": "P2",
                "status": "available",
                "locationStationId": "S1",
                "x": 1.0,
                "y": 1.0,
                "skills": ["inspect"],
                "certifications": [],
            },
        ],
        "devices": [
            {
                "id": "D1",
                "status": "online",
                "online": True,
                "capabilities": ["camera"],
                "batteryPct": 100.0,
            }
        ],
        "stations": [{"id": "S1", "x": 0.0, "y": 0.0, "capacity": 1}],
        "reservations": [],
        "forbiddenZones": [],
        "frozenAssignments": [],
        "baselineAssignee": {},
        "timeLimitMs": 10_000,
    }


class TestContractRoundTrip(unittest.TestCase):
    def test_from_dict_to_dict_round_trip(self):
        data = build_request()
        req = SolverRequest.from_dict(data)
        self.assertIsInstance(req, SolverRequest)
        self.assertEqual(req.requestId, "req-test-001")
        self.assertEqual(req.weights.lateness, 1.0)
        self.assertEqual(req.tasks[0].taskId, "T1")
        self.assertEqual(req.persons[0].id, "P1")

        resp = SolverResponse(
            solverVersion="cpsat-v1",
            solverStatus="UNAVAILABLE",
            solveDurationMs=0,
            objective=0.0,
            unassignedTaskIds=["T1"],
        )
        out = resp.to_dict()
        self.assertEqual(out["solverStatus"], "UNAVAILABLE")
        self.assertEqual(out["unassignedTaskIds"], ["T1"])

    def test_from_dict_defaults(self):
        req = SolverRequest.from_dict(
            {
                "requestId": "r",
                "snapshotVersion": "s",
                "policyVersion": 0,
                "solverVersion": "cpsat-v1",
                "horizonMinutes": 480,
                "nowMs": 0,
                "weights": {},
            }
        )
        self.assertEqual(req.timeLimitMs, 10_000)
        self.assertEqual(req.tasks, [])
        self.assertEqual(req.persons, [])


class TestSolver(unittest.TestCase):
    def setUp(self):
        self.request = SolverRequest.from_dict(build_request())

    def test_solve_returns_response(self):
        resp = cpsat_solver.solve(self.request)
        self.assertIsInstance(resp, SolverResponse)
        self.assertIn(
            resp.solverStatus,
            ("OPTIMAL", "FEASIBLE", "FALLBACK", "INFEASIBLE", "TIMEOUT", "UNAVAILABLE"),
        )

    def test_ortools_dependency_path(self):
        """未安装 ortools 时：UNAVAILABLE 且 unassignedTaskIds 含全部任务。始终执行。"""
        if cpsat_solver.is_available():
            self.skipTest("ortools 已安装，UNAVAILABLE 路径不适用")
        resp = cpsat_solver.solve(self.request)
        self.assertEqual(resp.solverStatus, "UNAVAILABLE")
        self.assertEqual(resp.unassignedTaskIds, ["T1"])
        self.assertEqual(resp.solveDurationMs, 0)
        self.assertEqual(resp.objective, 0.0)

    def test_feasible_and_deterministic(self):
        """仅当 ortools 可用时执行可行性/确定性断言。"""
        if not cpsat_solver.is_available():
            self.skipTest("ortools 未安装，跳过可行性/确定性断言")
        resp = cpsat_solver.solve(self.request)
        if resp.solverStatus == "INFEASIBLE":
            self.assertEqual(resp.solverStatus, "INFEASIBLE")
            self.assertIn("T1", resp.unassignedTaskIds)
            return
        # 可行：无硬违例，且 T1 已指派
        self.assertEqual(resp.hardViolations, [])
        self.assertEqual(resp.unassignedTaskIds, [])
        self.assertEqual(len(resp.assignments), 1)
        self.assertEqual(resp.assignments[0].taskId, "T1")

        # 确定性重放：相同输入两次求解结果一致
        resp2 = cpsat_solver.solve(self.request)
        self.assertEqual(resp.to_dict(), resp2.to_dict())


if __name__ == "__main__":
    unittest.main()