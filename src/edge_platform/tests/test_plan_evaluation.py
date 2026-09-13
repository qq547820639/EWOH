"""Station existence, availability and concurrent capacity in deterministic evaluations."""

import unittest

from edge_platform.scheduler.models import CandidateAssignment, SchedulePlan, WorldStateSnapshot
from edge_platform.scheduler.plan_evaluation import evaluate_plan


class StationEvaluationTest(unittest.TestCase):
    def evaluate(self, station, windows):
        assignments = [
            CandidateAssignment(
                task_id=f"task-{index}", person_id=f"person-{index}", station_id="station",
                route={"reachable": True},
                planned_start=f"2026-09-10T{start}:00Z", planned_end=f"2026-09-10T{end}:00Z",
            )
            for index, (start, end) in enumerate(windows)
        ]
        snapshot = WorldStateSnapshot(
            snapshot_id="station-snapshot",
            tasks=[{"task_id": assignment.task_id} for assignment in assignments],
            persons=[{"person_id": assignment.person_id} for assignment in assignments],
            stations=[{"station_id": "station", **station}],
        )
        return evaluate_plan(
            SchedulePlan(plan_id="station-plan", assignments=assignments), snapshot,
            [assignment.task_id for assignment in assignments],
        )

    def test_unavailable_station_rejects_otherwise_valid_plan(self):
        cases = [{"available": False}, {"active": False}, {"online": 0}]
        cases.extend({"status": status} for status in (
            "OFFLINE", "blocked", "fault", "faulty", "maintenance", "unavailable", "disabled", "inactive",
        ))
        for station in cases:
            with self.subTest(station=station):
                result = self.evaluate(station, [("08:00", "09:00")])
                self.assertFalse(result["feasible"])
                self.assertIn("STATION_UNAVAILABLE", {blocker["code"] for blocker in result["blockers"]})

    def test_capacity_zero_full_or_invalid_fails_closed(self):
        for station in (
            {"capacity": 0}, {"capacity": -1}, {"capacity": "unknown"}, {"capacity": 1.5},
            {"capacity": 1, "current_occupancy": 1}, {"capacity": 2, "occupancy": 2},
            {"capacity": 2, "current_occupancy": -1}, {"capacity": 2, "current_occupancy": "unknown"},
        ):
            with self.subTest(station=station):
                result = self.evaluate(station, [("08:00", "09:00")])
                self.assertFalse(result["feasible"])
                self.assertIn("STATION_CAPACITY", {blocker["code"] for blocker in result["blockers"]})

    def test_capacity_allows_concurrent_work_only_up_to_limit(self):
        windows = [("08:00", "09:00"), ("08:30", "09:30")]
        self.assertTrue(self.evaluate({"capacity": 2}, windows)["feasible"])
        for station in ({}, {"capacity": 1}, {"capacity": 2, "current_occupancy": 1}):
            with self.subTest(station=station):
                result = self.evaluate(station, windows)
                self.assertFalse(result["feasible"])
                self.assertIn("STATION_CAPACITY", {blocker["code"] for blocker in result["blockers"]})

    def test_capacity_sweep_counts_peak_concurrency_and_allows_touching_windows(self):
        windows = [("08:00", "08:30"), ("08:30", "09:00"), ("08:00", "09:00")]
        self.assertTrue(self.evaluate({"capacity": 2}, windows)["feasible"])
        self.assertTrue(self.evaluate({"capacity": 1}, windows[:2])["feasible"])
        result = self.evaluate({"capacity": 2}, [*windows, ("08:15", "08:45")])
        self.assertFalse(result["feasible"])
        self.assertIn("STATION_CAPACITY", {blocker["code"] for blocker in result["blockers"]})


if __name__ == "__main__":
    unittest.main()
