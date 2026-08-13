"""CP-SAT warm start / rolling horizon 纯函数测试（Phase 2，不依赖 ortools）。

运行：
    PYTHONPATH=src python -m pytest src/edge_platform/tests/test_warm_start_rolling.py -q
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.scheduler.cpsat.contract import SolverTask  # noqa: E402
from edge_platform.scheduler.cpsat.solver import (  # noqa: E402
    compute_warm_start_hints,
    partition_tasks_into_windows,
)

MINUTE = 60_000


def _task(task_id, earliest_start_ms):
    return SolverTask(
        taskId=task_id,
        priority=1.0,
        earliestStartMs=earliest_start_ms,
        dueMs=None,
        durationMs=30 * MINUTE,
    )


class TestWarmStartHints(unittest.TestCase):
    def test_keeps_valid_baseline_pairs(self):
        tasks = [_task("t1", 0), _task("t2", 0)]
        hints = compute_warm_start_hints(
            {"t1": "p1", "t2": "p2", "t3": "p1"}, tasks, ["p1", "p2", "p3"]
        )
        self.assertEqual(set(hints), {("t1", "p1"), ("t2", "p2")})

    def test_drops_unknown_task_or_person(self):
        tasks = [_task("t1", 0)]
        hints = compute_warm_start_hints(
            {"t1": "pX", "tMissing": "p1"}, tasks, ["p1"]
        )
        self.assertEqual(hints, [])

    def test_drops_none_person(self):
        tasks = [_task("t1", 0)]
        hints = compute_warm_start_hints({"t1": None}, tasks, ["p1"])
        self.assertEqual(hints, [])


class TestPartitionWindows(unittest.TestCase):
    def test_single_window_when_disabled_or_large(self):
        tasks = [_task("t1", 0), _task("t2", 30 * MINUTE)]
        self.assertEqual(
            partition_tasks_into_windows(tasks, 0, 480, 0),
            [["t1", "t2"]],
        )
        self.assertEqual(
            partition_tasks_into_windows(tasks, 0, 60, 120),
            [["t1", "t2"]],
        )

    def test_partition_by_earliest_start(self):
        tasks = [
            _task("a", 0),
            _task("b", 30 * MINUTE),
            _task("c", 90 * MINUTE),
        ]
        # 480 分钟 horizon，120 分钟窗口 → a/b 在窗口0，c 在窗口1（90min 落入 [60,120)？）
        # 90 分钟落入 window 0（[0,120)），故 a/b/c 同窗。改用 60 分钟窗口：
        windows = partition_tasks_into_windows(tasks, 0, 480, 60)
        # a[0,60) b[0?30min→[0,60)] c[90min→[60,120)]
        self.assertEqual(windows[0], ["a", "b"])
        self.assertEqual(windows[1], ["c"])

    def test_out_of_horizon_into_last_window(self):
        tasks = [_task("a", 0), _task("b", 500 * MINUTE)]  # b 在 480 视野外
        windows = partition_tasks_into_windows(tasks, 0, 480, 60)
        self.assertIn("b", windows[-1])

    def test_empty(self):
        self.assertEqual(partition_tasks_into_windows([], 0, 480, 60), [])


if __name__ == "__main__":
    unittest.main()
