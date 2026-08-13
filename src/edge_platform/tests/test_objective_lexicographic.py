"""CP-SAT objective 分层（Phase 2）测试——不依赖 ortools，纯 Python 即可运行。

运行：
    PYTHONPATH=src python -m pytest src/edge_platform/tests/test_objective_lexicographic.py -q
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.scheduler.cpsat.contract import (  # noqa: E402
    CandidateCost,
    SolverRequest,
    SolverTask,
    SolverWeights,
)
from edge_platform.scheduler.cpsat.objective import (  # noqa: E402
    OBJECTIVE_LEVELS,
    compute_unassigned_scale,
)


def _make_request(tasks=1, horizon=480, travel_m=0.0, lateness=1.0, wait=1.0, churn=1.0):
    weights = SolverWeights(lateness=lateness, stationWait=wait, travel=1.0, churn=churn)
    return SolverRequest(
        requestId="r",
        snapshotVersion="s",
        policyVersion=1,
        solverVersion="cpsat-v1",
        horizonMinutes=horizon,
        nowMs=0,
        weights=weights,
        tasks=[
            SolverTask(
                taskId=f"t{i}",
                priority=1.0,
                earliestStartMs=0,
                dueMs=None,
                durationMs=1,
            )
            for i in range(tasks)
        ],
        candidateCosts=[
            CandidateCost(taskId="t0", personId="p0", distanceMeters=travel_m)
        ],
    )


class TestObjectiveLexicographic(unittest.TestCase):
    def test_levels_constant(self):
        self.assertEqual(OBJECTIVE_LEVELS[0], "unassigned")
        self.assertEqual(OBJECTIVE_LEVELS[1], "lateness")

    def test_scale_strictly_dominates_travel_bound(self):
        # 10 个任务 + 1000m 候选路径 → 软目标 travel 上界 ≈ 10 * 1000 = 10000。
        req = _make_request(tasks=10, travel_m=1000.0)
        scale = compute_unassigned_scale(req)
        self.assertIsInstance(scale, int)
        self.assertGreater(scale, 10 * 1000)

    def test_scale_is_int_and_non_overflowing(self):
        # 大规模请求下 scale 仍为 int 且 scale * n_tasks 不溢出 int64。
        req = _make_request(tasks=1000, travel_m=100000.0)
        scale = compute_unassigned_scale(req)
        self.assertIsInstance(scale, int)
        self.assertLess(scale * max(1, len(req.tasks)), (2 ** 63) - 1)

    def test_scale_grows_with_travel(self):
        small = compute_unassigned_scale(_make_request(travel_m=10.0))
        large = compute_unassigned_scale(_make_request(travel_m=100000.0))
        self.assertGreater(large, small)

    def test_empty_soft_bounds_still_positive(self):
        # 无任务、无候选成本 → 软目标上界为 0，scale 仍为正整数。
        req = _make_request(tasks=0, travel_m=0.0)
        scale = compute_unassigned_scale(req)
        self.assertIsInstance(scale, int)
        self.assertGreaterEqual(scale, 1)


if __name__ == "__main__":
    unittest.main()
