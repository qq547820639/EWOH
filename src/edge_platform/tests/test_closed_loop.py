"""Exercise the public workflow and its safety boundaries without a production database."""

import json
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from edge_platform.run import build_scheduler
from edge_platform.scenario.closed_loop import SimulatedFactoryStorage, run_closed_loop
from edge_platform.scheduler.models import PLAN_SHADOW, CandidateAssignment, SchedulePlan, WorldStateSnapshot
from edge_platform.scheduler.plan_evaluation import evaluate_plan
from edge_platform.scheduler.repository import SchedulingRepository
from edge_platform.scheduler.scheduler_service import (
    AdvisoryOnlyError,
    IllegalStateError,
    PlanConflictError,
    PlanStaleError,
)
from edge_platform.scheduler.world_state import WorldStateService
from edge_platform.spatial import now_iso


class ClosedLoopTest(unittest.TestCase):
    def test_http_fault_to_feedback_and_recovery(self):
        with patch.dict(os.environ, {"EWOH_RUNTIME_MODE": "simulation"}):
            result = run_closed_loop()
        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(result["candidate_plans"]), 3)
        self.assertTrue(result["duplicate_observation"]["duplicate"])
        self.assertEqual(result["restored_feedback_count"], 1)
        self.assertFalse(result["learning"]["production_training_eligible"])
        self.assertEqual([entry["status"] for entry in result["operations"]].count(409), 2)
        self.assertTrue(result["evaluation"]["feasible"])
        for actual in result["feedback"]["actual"].values():
            self.assertEqual(actual["status"], "completed")
            self.assertAlmostEqual(actual["duration_delta_seconds"], actual["duration_seconds"] - 600)
        json.dumps(result, allow_nan=False)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.storage = SimulatedFactoryStorage(Path(self.directory.name) / "factory.db")
        self.addCleanup(self.storage.close)
        self.repository = SchedulingRepository(self.storage)
        self.scheduler, _ = build_scheduler(self.storage, self.repository, None, mode="simulation")

    def plan(self):
        task = self.scheduler.create_task(
            actor_id="sim-dispatcher", station_id="PACKING", task_type="搬运",
            required_skills=["搬运"], earliest_start=now_iso(), estimated_duration_sec=600,
        )
        request = self.scheduler.create_request([task.task_id], "device_fault", "", "sim-dispatcher")
        return self.scheduler.generate_plans(request.request_id)[0]

    def test_request_selects_only_explicit_tasks(self):
        unrelated = self.scheduler.create_task(actor_id="sim-dispatcher", task_type="无关工序")
        plan = self.plan()
        self.assertEqual(len(plan.assignments), 1)
        self.assertNotIn(unrelated.task_id, {assignment.task_id for assignment in plan.assignments})

    def test_unknown_task_is_not_invented(self):
        request = self.scheduler.create_request(["MISSING"], "manual", "", "sim-dispatcher")
        with self.assertRaises(PlanConflictError):
            self.scheduler.generate_plans(request.request_id)
        self.assertEqual(self.scheduler.list_plans(), [])

    def test_qualification_revocation_is_used_by_the_next_solve(self):
        self.plan()
        for person in self.storage.list_people():
            self.storage.upsert_person(**{**person, "skills": []})
        plan = self.plan()
        self.assertEqual(plan.assignments, [])

    def test_persisted_shadow_can_be_evaluated_after_restart(self):
        plan = self.plan()
        restarted, _ = build_scheduler(self.storage, self.repository, None, mode="simulation")
        restarted.hydrate_from_repository()
        evaluated = restarted.simulate(plan.plan_id, "sim-dispatcher", "重启后继续评估")
        self.assertEqual(evaluated.status, "pending_review")

    def test_world_snapshot_ids_are_unique_across_instances(self):
        first = WorldStateService().build_snapshot(self.storage)
        second = WorldStateService().build_snapshot(self.storage)
        self.assertNotEqual(first.snapshot_id, second.snapshot_id)

    def test_invalid_route_remains_shadow(self):
        plan = self.plan()
        plan.assignments[0].route["reachable"] = False
        evaluated = self.scheduler.simulate(plan.plan_id, "sim-dispatcher", "核实路径")
        self.assertEqual(evaluated.status, PLAN_SHADOW)
        self.assertIn("ROUTE_UNVERIFIED", {blocker["code"] for blocker in evaluated.constraint_summary["evaluation"]["blockers"]})
        with self.assertRaises(IllegalStateError):
            self.scheduler.confirm(plan.plan_id, "sim-supervisor", "禁止绕过")

    def test_advisory_cannot_promote_or_record_execution_feedback(self):
        plan = self.plan()
        self.scheduler.advisory_only = True
        with self.assertRaises(AdvisoryOnlyError):
            self.scheduler.simulate(plan.plan_id, "sim-dispatcher", "评估")
        with self.assertRaises(AdvisoryOnlyError):
            self.scheduler.record_execution_feedback(plan.plan_id, "sim-supervisor", "once")

    def test_duplicate_concurrent_feedback_is_single_persisted_fact(self):
        plan = self.plan()
        self.scheduler.simulate(plan.plan_id, "sim-dispatcher", "评估")
        self.scheduler.confirm(plan.plan_id, "sim-supervisor", "批准模拟派工")
        assignment = self.scheduler.execute(plan.plan_id)[0]
        with self.assertRaises(IllegalStateError):
            self.scheduler.record_execution_feedback(plan.plan_id, "sim-supervisor", "once")
        self.scheduler.set_assignment_status(assignment.assignment_id, "executing", "sim-worker")
        self.scheduler.set_assignment_status(assignment.assignment_id, "completed", "sim-worker")
        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = [executor.submit(self.scheduler.record_execution_feedback, plan.plan_id, "sim-supervisor", "once") for _ in range(8)]
            feedback_ids = {future.result().feedback_id for future in futures}
        self.assertEqual(len(feedback_ids), 1)
        self.assertEqual(len(self.repository.list_feedback(plan.plan_id)), 1)

    def test_failed_evaluation_write_does_not_promote_memory(self):
        plan = self.plan()
        with patch.object(self.repository, "save_plan", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.scheduler.simulate(plan.plan_id, "sim-dispatcher", "评估")
        self.assertEqual(self.scheduler.get_plan(plan.plan_id).status, PLAN_SHADOW)

    def test_changed_skills_after_review_require_replanning(self):
        plan = self.plan()
        self.scheduler.simulate(plan.plan_id, "sim-dispatcher", "评估")
        person = next(person for person in self.storage.list_people() if person["person_id"] == plan.assignments[0].person_id)
        self.storage.upsert_person(**{**person, "skills": []})
        with self.assertRaises(PlanStaleError):
            self.scheduler.confirm(plan.plan_id, "sim-supervisor", "人员资质已变化")

    def test_device_fault_after_approval_prevents_dispatch(self):
        plan = self.plan()
        self.scheduler.simulate(plan.plan_id, "sim-dispatcher", "评估")
        self.scheduler.confirm(plan.plan_id, "sim-supervisor", "批准")
        device = next(device for device in self.storage.list_devices() if device["device_id"] == plan.assignments[0].device_id)
        self.storage.upsert_device(**{**device, "online": 0})
        with self.assertRaises(PlanStaleError):
            self.scheduler.execute(plan.plan_id)
        self.assertEqual(self.scheduler.list_assignments(), [])

    def test_stale_observation_cannot_change_device(self):
        observation = {
            "record_id": "stale", "device_id": "EXO-001", "source_type": "simulated",
            "timestamp": (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat(),
            "quality": {"status": "good"},
        }
        result = self.storage.observe_device_fault(observation)
        self.assertFalse(result["accepted"])
        self.assertTrue(next(device for device in self.storage.list_devices() if device["device_id"] == "EXO-001")["online"])
        self.assertIsNone(self.storage.get_event("stale"))

    def test_evaluation_detects_overlapping_resources_and_missing_tasks(self):
        snapshot = WorldStateSnapshot(
            snapshot_id="test", persons=[{"person_id": "person"}], devices=[],
            tasks=[{"task_id": "first"}, {"task_id": "second"}, {"task_id": "missing"}],
        )
        assignment = CandidateAssignment(
            task_id="first", person_id="person", route={"reachable": True},
            planned_start="2026-09-10T08:00:00Z", planned_end="2026-09-10T08:10:00Z",
        )
        overlapping = deepcopy(assignment)
        overlapping.task_id = "second"
        plan = SchedulePlan(plan_id="plan", assignments=[assignment, overlapping])
        evaluation = evaluate_plan(plan, snapshot, ["first", "second", "missing"])
        self.assertFalse(evaluation["feasible"])
        self.assertEqual({blocker["code"] for blocker in evaluation["blockers"]}, {"RESOURCE_CONFLICT", "TASKS_UNASSIGNED"})

    def test_evaluation_rejects_unknown_station(self):
        snapshot = WorldStateSnapshot(
            snapshot_id="station-check", persons=[{"person_id": "person", "active": True}],
            tasks=[{"task_id": "task", "status": "pending"}], stations=[{"station_id": "known"}],
        )
        assignment = CandidateAssignment(
            task_id="task", person_id="person", station_id="missing", route={"reachable": True},
            planned_start="2026-09-10T08:00:00Z", planned_end="2026-09-10T08:10:00Z",
        )
        evaluation = evaluate_plan(SchedulePlan(plan_id="station-plan", assignments=[assignment]), snapshot, ["task"])
        self.assertFalse(evaluation["feasible"])
        self.assertIn("STATION_MISSING", {blocker["code"] for blocker in evaluation["blockers"]})

    def test_persisted_snapshot_preserves_source_timestamps_after_restart(self):
        plan = self.plan()
        original = plan._world_snapshot
        expected_sources = dict(original.source_timestamps)
        self.assertTrue(expected_sources["persons_ts"])
        self.assertTrue(expected_sources["devices_ts"])
        self.storage.close()

        reopened = SimulatedFactoryStorage(Path(self.directory.name) / "factory.db")
        self.addCleanup(reopened.close)
        repository = SchedulingRepository(reopened)
        restarted, _ = build_scheduler(reopened, repository, None, mode="simulation")
        restarted.hydrate_from_repository()
        restored = restarted.get_plan(plan.plan_id)
        self.assertFalse(hasattr(restored, "_world_snapshot"))
        evaluated = restarted.simulate(plan.plan_id, "sim-dispatcher", "重启后验证来源时间")
        evaluation = evaluated.constraint_summary["evaluation"]
        self.assertEqual(evaluated.status, "pending_review")
        self.assertEqual(evaluation["snapshot_id"], original.snapshot_id)
        self.assertEqual(evaluation["snapshot_at"], original.timestamp)
        self.assertEqual(evaluation["source_timestamps"], expected_sources)
        self.assertEqual(repository.get_snapshot(original.snapshot_id)["source_timestamps"], expected_sources)
        self.assertEqual(repository.get_plan(plan.plan_id)["constraint_summary"]["evaluation"], evaluation)

    def test_unknown_station_remains_shadow_and_cannot_be_confirmed(self):
        plan = self.plan()
        plan.assignments[0].station_id = "MISSING"
        evaluated = self.scheduler.simulate(plan.plan_id, "sim-dispatcher", "核实工位")
        self.assertEqual(evaluated.status, PLAN_SHADOW)
        self.assertEqual(evaluated.constraint_summary["evaluation"]["blockers"], [
            {"code": "STATION_MISSING", "task_id": plan.assignments[0].task_id, "station_id": "MISSING"},
        ])
        self.assertEqual(self.repository.get_plan(plan.plan_id)["status"], PLAN_SHADOW)
        with self.assertRaises(IllegalStateError):
            self.scheduler.confirm(plan.plan_id, "sim-supervisor", "禁止绕过")


if __name__ == "__main__":
    unittest.main()
