"""智能调度持久化仓储单元测试：CRUD、乐观锁冲突、重启后数据保留。

纯 Python 标准库 unittest；用 tempfile 创建临时 sqlite 库，实例化 stubs.Storage
验证调度数据可持久化并在重新打开同一 db_path 后仍可读取。

运行：PYTHONPATH=src python -m unittest edge_platform.tests.test_repository -v
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.scheduler.models import (
    Reservation,
    ScheduleFeedback,
    SchedulePlan,
    ScheduleRequestMW,
    Task,
    WorldStateSnapshot,
)
from edge_platform.scheduler.repository import SchedulingRepository, VersionConflictError
from edge_platform.stubs import Storage


class SchedulingRepositoryTest(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self._tmpdir.name, "test_sched.db")
        self.storage = Storage(self.db_path)
        self.storage.init_db()
        self.repo = SchedulingRepository(self.storage)

    def tearDown(self):
        self.storage.close()
        self._tmpdir.cleanup()

    def test_save_load_task(self):
        task = Task(task_id="t-1", task_type="搬运", priority=3, status="draft")
        self.repo.save_task(task)
        got = self.repo.get_task("t-1")
        self.assertIsNotNone(got)
        self.assertEqual(got["task_id"], "t-1")
        self.assertEqual(got["task_type"], "搬运")
        self.assertEqual(got["priority"], 3)
        # list
        self.assertEqual(len(self.repo.list_tasks()), 1)
        self.assertEqual(len(self.repo.list_tasks(status="draft")), 1)
        self.assertEqual(len(self.repo.list_tasks(status="done")), 0)

    def test_update_task_optimistic_lock_conflict(self):
        task = Task(task_id="t-2", task_type="装配")
        self.repo.save_task(task)
        # 正确版本：成功且 version 自增
        updated = self.repo.update_task("t-2", expected_version=1, status="pending_approval")
        self.assertEqual(updated["version"], 2)
        self.assertEqual(updated["status"], "pending_approval")
        # 错误版本：抛 VersionConflictError
        with self.assertRaises(VersionConflictError) as cm:
            self.repo.update_task("t-2", expected_version=1, status="done")
        self.assertEqual(cm.exception.current_version, 2)
        self.assertEqual(cm.exception.expected_version, 1)

    def test_save_load_plan_with_assignments(self):
        plan = SchedulePlan(
            plan_id="pln-1",
            request_id="req-1",
            version=1,
            objective_score=0.85,
            assignments=[
                {
                    "assignment_id": "asn-p1",
                    "task_id": "t-1",
                    "person_id": "p-1",
                    "device_id": "d-1",
                    "planned_start": "2026-08-07T08:00:00+00:00",
                    "planned_end": "2026-08-07T09:00:00+00:00",
                    "score": 0.9,
                }
            ],
        )
        self.repo.save_plan(plan)
        got = self.repo.get_plan("pln-1")
        self.assertIsNotNone(got)
        self.assertEqual(got["plan_id"], "pln-1")
        self.assertEqual(len(got["assignments"]), 1)
        self.assertEqual(got["assignments"][0]["task_id"], "t-1")
        self.assertEqual(len(self.repo.list_plans()), 1)

    def test_save_load_reservation(self):
        res = Reservation(
            reservation_id="RSV-1",
            resource_id="P-001",
            assignment_id="asn-1",
            plan_id="pln-1",
            start_at="2026-08-07T08:00:00+00:00",
            end_at="2026-08-07T09:00:00+00:00",
            status="active",
            version=1,
        )
        self.repo.save_reservation(res)
        rows = self.repo.list_reservations()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["resource_id"], "P-001")
        # 乐观锁更新预约
        updated = self.repo.update_reservation("RSV-1", expected_version=1, status="released")
        self.assertEqual(updated["version"], 2)
        self.assertEqual(updated["status"], "released")
        with self.assertRaises(VersionConflictError):
            self.repo.update_reservation("RSV-1", expected_version=1, status="active")

    def test_record_decision_and_feedback_and_snapshot(self):
        decision_id = self.repo.record_decision(
            "pln-1", 1, "confirm", "leader1", "综合最优", None, {"plan_id": "pln-1", "status": "approved"}
        )
        self.assertTrue(decision_id.startswith("DEC-"))
        decisions = self.repo.list_decisions(plan_id="pln-1")
        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0]["action"], "confirm")

        fb = ScheduleFeedback(feedback_id="FB-1", plan_id="pln-1", accepted=True, actual={"ok": 1})
        self.repo.save_feedback(fb)
        fbs = self.repo.list_feedback(plan_id="pln-1")
        self.assertEqual(len(fbs), 1)
        self.assertTrue(fbs[0]["accepted"])

        snap = WorldStateSnapshot(snapshot_id="WS-1", persons=[{"person_id": "p-1"}], tasks=[{"task_id": "t-1"}])
        self.repo.save_snapshot(snap)
        got_snap = self.repo.get_snapshot("WS-1")
        self.assertIsNotNone(got_snap)
        self.assertEqual(got_snap["persons"][0]["person_id"], "p-1")
        self.assertEqual(len(self.repo.list_snapshots()), 1)

    def test_persistence_across_close_reopen(self):
        """写入数据 → 关闭并重新打开同一 db_path → 数据仍在（服务重启不丢失）。"""
        task = Task(task_id="t-restart", task_type="巡检", priority=5)
        self.repo.save_task(task)
        req = ScheduleRequestMW(request_id="req-restart", task_ids=["t-restart"], trigger_type="manual")
        self.repo.save_request(req)
        plan = SchedulePlan(plan_id="pln-restart", request_id="req-restart", status="shadow")
        self.repo.save_plan(plan)
        self.storage.close()

        storage2 = Storage(self.db_path)
        storage2.init_db()
        repo2 = SchedulingRepository(storage2)
        self.assertEqual(repo2.get_task("t-restart")["task_type"], "巡检")
        self.assertEqual(repo2.get_request("req-restart")["trigger_type"], "manual")
        self.assertEqual(repo2.get_plan("pln-restart")["status"], "shadow")
        storage2.close()


if __name__ == "__main__":
    unittest.main()