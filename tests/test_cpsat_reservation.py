"""A5 回归测试：CP-SAT reservation 按时间窗重叠判定（而非"任意预约即禁止分配"）。

背景：solver.py 硬约束 4 曾对候选 (pi,di,si) 只要该资源存在任意 SolverReservation
就 `model.Add(present == 0)` —— 时间上不重叠的预约也禁止分配。修复后 reservation
建模为 fixed interval 加入 interval_by_resource，由 AddNoOverlap 统一约束：
任务区间与预约区间不重叠即可（可排在其前或其后）。

本测试：
1. 无 ortools 环境：验证纯函数 `_reservation_interval_specs`（key 映射 / 异常预约跳过）
   与 `solve()` 的 UNAVAILABLE 回退路径；
2. ortools 可用时（@skipUnless）：真实求解验证——任务在预约时间窗外可分配、
   窗内不可分配。

运行：PYTHONPATH=src python -m pytest tests/test_cpsat_reservation.py -q
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

from edge_platform.scheduler.cpsat.contract import SolverRequest, SolverReservation  # noqa: E402
from edge_platform.scheduler.cpsat.solver import (  # noqa: E402
    _fixed_interval_bounds,
    _reservation_interval_specs,
    solve,
)


class FixedIntervalBoundsTest(unittest.TestCase):
    """F1 回归：fixed interval 必须满足 start+size==end（NewIntervalVar 硬性要求）。

    直接对毫秒各自整除分钟会出现亚分钟余数不一致（startMs=36_030_000→600、
    endMs=37_800_000→630、size=(1_770_000)//60_000=29 → 600+29=629≠630
    → 模型整体 INFEASIBLE）。纯逻辑测试，不依赖 ortools。
    """

    def test_non_integer_minute_reservation_consistent(self):
        """QA 复现推演：非整分钟预约 → start+size==end。"""
        start, size, end = _fixed_interval_bounds(36_030_000, 37_800_000)
        self.assertEqual((start, size, end), (600, 30, 630))
        self.assertEqual(start + size, end)

    def test_short_sub_minute_reservation_uses_min_end(self):
        """短预约（40 秒，整除后 end==start）→ end=max(start+1, ...) 分支，size≥1。"""
        start, size, end = _fixed_interval_bounds(36_030_000, 36_070_000)
        self.assertEqual(start, 600)
        self.assertEqual(end, 601)
        self.assertEqual(size, 1)
        self.assertEqual(start + size, end)

    def test_multi_minute_reservation_consistent(self):
        start, size, end = _fixed_interval_bounds(36_030_000, 38_000_000)
        self.assertEqual((start, end), (600, 633))
        self.assertEqual(size, end - start)
        self.assertEqual(start + size, end)

    def test_exact_minute_reservation_consistent(self):
        """整分钟预约（无余数）同样保持 start+size==end。"""
        start, size, end = _fixed_interval_bounds(36_000_000, 37_800_000)
        self.assertEqual((start, size, end), (600, 30, 630))
        self.assertEqual(start + size, end)


class ReservationIntervalSpecTest(unittest.TestCase):
    """纯函数测试：不依赖 ortools，验证 key 映射与防御性跳过。"""

    def test_key_mapping_matches_candidate_prefixes(self):
        specs = _reservation_interval_specs(
            [
                SolverReservation(resourceId="p1", resourceType="person", startMs=0, endMs=30_000),
                SolverReservation(resourceId="d1", resourceType="device", startMs=0, endMs=30_000),
                SolverReservation(resourceId="s1", resourceType="station", startMs=0, endMs=30_000),
            ]
        )
        self.assertEqual(
            specs,
            [
                ("p:p1", 0, 30_000),
                ("d:d1", 0, 30_000),
                ("s:s1", 0, 30_000),
            ],
        )

    def test_abnormal_reservation_skipped(self):
        """endMs <= startMs 的异常预约直接跳过（防御），未知 resourceType 跳过。"""
        specs = _reservation_interval_specs(
            [
                SolverReservation(resourceId="p1", resourceType="person", startMs=30_000, endMs=30_000),
                SolverReservation(resourceId="d1", resourceType="device", startMs=40_000, endMs=10_000),
                SolverReservation(resourceId="x1", resourceType="robot", startMs=0, endMs=30_000),
            ]
        )
        self.assertEqual(specs, [])


@unittest.skipUnless(_ORT_TOOLS_AVAILABLE, "ortools 未安装，跳过真实求解 reservation fixture 测试")
class CpSatReservationRealSolverTest(unittest.TestCase):
    """ortools 可用时的真实求解验证（CI 具备依赖时执行）。"""

    def _make_req(self, reservations):
        return SolverRequest.from_dict(
            {
                "requestId": "res-fixture",
                "snapshotVersion": "WS-RES",
                "policyVersion": 1,
                "solverVersion": "cpsat-v1",
                "horizonMinutes": 120,
                "nowMs": 0,
                "weights": {"lateness": 1.0, "travel": 1.0, "stationWait": 1.0},
                "tasks": [
                    {
                        "taskId": "t1",
                        "priority": 1.0,
                        "earliestStartMs": 0,
                        "dueMs": None,
                        "durationMs": 30_000,
                        "requiredSkills": [],
                        "candidateStationIds": ["st1"],
                    }
                ],
                "persons": [
                    {"id": "p1", "status": "available", "locationStationId": "st1", "x": 0, "y": 0, "skills": []}
                ],
                "devices": [],
                "stations": [{"id": "st1", "x": 0, "y": 0, "capacity": 5}],
                "reservations": [r.__dict__ for r in reservations],
                "forbiddenZones": [],
                "frozenAssignments": [],
                "baselineAssignee": {},
                "timeLimitMs": 3000,
            }
        )

    def test_task_assignable_outside_reservation_window(self):
        """预约在未来（now+60min 起 30min）：任务应可分配到预约之前。"""
        resp = solve(
            self._make_req(
                [
                    SolverReservation(
                        resourceId="p1", resourceType="person", startMs=60 * 60_000, endMs=90 * 60_000
                    )
                ]
            )
        )
        self.assertEqual(resp.solverStatus, "OPTIMAL")
        self.assertEqual(resp.unassignedTaskIds, [], "预约窗外任务必须可分配（A5 修复核心）")
        self.assertEqual(len(resp.assignments), 1)
        self.assertEqual(resp.assignments[0].personId, "p1")
        self.assertLessEqual(resp.assignments[0].endMs, 60 * 60_000, "任务应排在预约之前")

    def test_task_blocked_inside_reservation_window(self):
        """预约覆盖整个任务可用窗口 → 任务不可分配（不冒充成功）。"""
        resp = solve(
            self._make_req(
                [
                    SolverReservation(
                        resourceId="p1", resourceType="person", startMs=0, endMs=2 * 60 * 60_000
                    )
                ]
            )
        )
        self.assertIn(resp.solverStatus, ("OPTIMAL", "FEASIBLE"))
        self.assertEqual(resp.unassignedTaskIds, ["t1"], "预约窗内任务必须如实未分配")

    def test_non_integer_minute_reservation_not_infeasible(self):
        """F1 回归：非整分钟预约（36_030_000→37_800_000，旧写法 start+size≠end）
        不得使模型整体 INFEASIBLE；窗外任务应可分配。"""
        resp = solve(
            self._make_req(
                [
                    SolverReservation(
                        resourceId="p1", resourceType="person", startMs=36_030_000, endMs=37_800_000
                    )
                ]
            )
        )
        self.assertIn(resp.solverStatus, ("OPTIMAL", "FEASIBLE"))
        self.assertEqual(resp.unassignedTaskIds, [], "F1 修复后窗外任务必须可分配（不得 INFEASIBLE）")
        self.assertEqual(resp.assignments[0].personId, "p1")
        self.assertLessEqual(resp.assignments[0].endMs, 36_030_000, "任务应排在预约之前")


class SolverUnavailableFallbackTest(unittest.TestCase):
    def test_unavailable_when_ortools_missing(self):
        """无 ortools → solve() 返回 UNAVAILABLE 回退路径（绝不冒充 CP-SAT 成功）。"""
        if _ORT_TOOLS_AVAILABLE:
            self.skipTest("ortools 已安装，不验证 UNAVAILABLE 回退")
        req = SolverRequest.from_dict(
            {
                "requestId": "x",
                "snapshotVersion": "v",
                "policyVersion": 1,
                "solverVersion": "cpsat-v1",
                "horizonMinutes": 10,
                "nowMs": 0,
                "weights": {},
                "tasks": [],
                "persons": [],
                "devices": [],
                "stations": [],
                "reservations": [],
                "frozenAssignments": [],
            }
        )
        resp = solve(req)
        self.assertEqual(resp.solverStatus, "UNAVAILABLE")
        self.assertEqual(resp.solverVersion, "cpsat-v1")
        self.assertTrue(any(v["type"] == "DEPENDENCY_UNAVAILABLE" for v in resp.hardViolations))


if __name__ == "__main__":
    unittest.main()
