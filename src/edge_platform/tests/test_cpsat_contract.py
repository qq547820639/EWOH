"""CP-SAT 求解契约测试（P0-2 / P0-3 / P0-4）。

覆盖（**不依赖 ortools**，纯 Python 即可运行）：
1. P0-2：Nest `SolverRequest.tasks` 发送的 `skillMatchMode` / `effectivePriorityScore`
   不再导致 `SolverTask(**t)` 抛 TypeError（旧实现缺字段 → worker 400 → CP-SAT 恒回退 heuristic）。
2. P0-2：ANY 技能匹配纯函数逻辑（任一即可）与 ALL（默认，全部必需）语义。
3. P0-3：`mustFinishByMs` 契约字段解析（硬截止与软 due 分离）。
4. P0-4：`candidateCosts` 契约字段解析（权威 RouteCost 矩阵透传）。

运行：
    PYTHONPATH=src python -m pytest src/edge_platform/tests/test_cpsat_contract.py -q
"""

import os
import sys
import unittest
from dataclasses import asdict

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.scheduler.cpsat.contract import (  # noqa: E402
    CandidateCost,
    SolverRequest,
    SolverTask,
)
from edge_platform.scheduler.cpsat.solver import (  # noqa: E402
    person_has_required_skills,
    travel_cost_for_candidate,
)


def _base_request(tasks):
    return {
        "requestId": "req-contract-1",
        "snapshotVersion": "WS-CONTRACT",
        "policyVersion": 1,
        "solverVersion": "cpsat-v1",
        "horizonMinutes": 120,
        "nowMs": 0,
        "weights": {"lateness": 1.0, "travel": 1.0},
        "tasks": tasks,
        "persons": [],
        "devices": [],
        "stations": [],
        "reservations": [],
        "forbiddenZones": [],
        "frozenAssignments": [],
        "baselineAssignee": {},
        "timeLimitMs": 1000,
    }


class CpsatContractTest(unittest.TestCase):
    def test_device_battery_unknown_and_zero_survive_request_roundtrip(self):
        for fields in ({}, {"batteryPct": None}, {"batteryPct": 0}, {"batteryPct": 100}):
            with self.subTest(fields=fields):
                body = _base_request([])
                body["devices"] = [{"id": "d1", "status": "available", "online": True, **fields}]
                request = SolverRequest.from_dict(body)
                self.assertEqual(request.devices[0].batteryPct, fields.get("batteryPct"))
                self.assertEqual(asdict(request)["devices"][0]["batteryPct"], fields.get("batteryPct"))

    def test_skill_match_mode_no_longer_throws_type_error(self):
        """P0-2 核心回归：Nest 发送的 skillMatchMode 字段必须被契约声明。

        旧实现 SolverTask 无此字段 → SolverTask(**t) 抛 TypeError
        （TypeError CONFIRMED: SolverTask.__init__() got an unexpected keyword
        argument 'skillMatchMode'）→ worker 400 → CP-SAT 在生产恒回退 heuristic。
        """
        req = SolverRequest.from_dict(
            _base_request(
                [
                    {
                        "taskId": "t1",
                        "priority": 1.0,
                        "earliestStartMs": 0,
                        "dueMs": None,
                        "durationMs": 30_000,
                        "requiredSkills": ["a", "b"],
                        "skillMatchMode": "ANY",
                        "effectivePriorityScore": 42.0,
                    }
                ]
            )
        )
        task: SolverTask = req.tasks[0]
        self.assertEqual(task.taskId, "t1")
        self.assertEqual(task.skillMatchMode, "ANY")
        self.assertEqual(task.effectivePriorityScore, 42.0)

    def test_skill_match_mode_defaults_to_all(self):
        """缺省 skillMatchMode → 'ALL'（向后兼容）。"""
        req = SolverRequest.from_dict(
            _base_request(
                [
                    {
                        "taskId": "t1",
                        "priority": 1.0,
                        "earliestStartMs": 0,
                        "dueMs": None,
                        "durationMs": 30_000,
                        "requiredSkills": ["a"],
                    }
                ]
            )
        )
        self.assertEqual(req.tasks[0].skillMatchMode, "ALL")

    def test_effective_priority_score_optional(self):
        """effectivePriorityScore 可缺省（None）。"""
        req = SolverRequest.from_dict(
            _base_request(
                [
                    {
                        "taskId": "t1",
                        "priority": 1.0,
                        "earliestStartMs": 0,
                        "dueMs": None,
                        "durationMs": 30_000,
                        "requiredSkills": [],
                    }
                ]
            )
        )
        self.assertIsNone(req.tasks[0].effectivePriorityScore)

    def test_must_finish_by_ms_parses(self):
        """P0-3：mustFinishByMs（硬截止）契约字段解析。"""
        req = SolverRequest.from_dict(
            _base_request(
                [
                    {
                        "taskId": "t1",
                        "priority": 1.0,
                        "earliestStartMs": 0,
                        "dueMs": 1_800_000,  # 软 due（lateness 罚项）
                        "mustFinishByMs": 3_600_000,  # 硬截止
                        "durationMs": 30_000,
                        "requiredSkills": [],
                    }
                ]
            )
        )
        task: SolverTask = req.tasks[0]
        self.assertEqual(task.dueMs, 1_800_000)
        self.assertEqual(task.mustFinishByMs, 3_600_000)

    def test_candidate_costs_parses(self):
        """P0-4：candidateCosts（权威 RouteCost 矩阵）契约字段解析。"""
        req = SolverRequest.from_dict(
            {
                **_base_request([]),
                "candidateCosts": [
                    {
                        "taskId": "t1",
                        "personId": "p1",
                        "stationId": "s1",
                        "distanceMeters": 120.5,
                        "etaSeconds": 60,
                        "dataQuality": "FRESH",
                        "fallbackReason": None,
                    }
                ],
            }
        )
        cc: CandidateCost = req.candidateCosts[0]
        self.assertEqual(cc.taskId, "t1")
        self.assertEqual(cc.personId, "p1")
        self.assertEqual(cc.stationId, "s1")
        self.assertEqual(cc.distanceMeters, 120.5)
        self.assertEqual(cc.etaSeconds, 60)
        self.assertEqual(cc.dataQuality, "FRESH")

    def test_skill_match_any_semantics(self):
        """P0-2：ANY=任一技能即可。"""
        self.assertTrue(
            person_has_required_skills(["a", "c"], ["a", "b"], "ANY")
        )
        self.assertTrue(person_has_required_skills(["b"], ["a", "b"], "ANY"))
        self.assertFalse(
            person_has_required_skills(["c"], ["a", "b"], "ANY")
        )

    def test_skill_match_all_semantics(self):
        """P0-2：ALL=全部必需（缺省语义）。"""
        self.assertTrue(
            person_has_required_skills(["a", "b"], ["a", "b"], "ALL")
        )
        self.assertFalse(
            person_has_required_skills(["a"], ["a", "b"], "ALL")
        )
        # 缺省 match_mode 即 ALL
        self.assertTrue(person_has_required_skills(["a", "b"], ["a", "b"]))
        self.assertFalse(person_has_required_skills(["a"], ["a", "b"]))

    def test_skill_match_empty_requirements(self):
        """空需求恒 True（ALL/ANY 均通过）。"""
        self.assertTrue(person_has_required_skills([], [], "ALL"))
        self.assertTrue(person_has_required_skills([], [], "ANY"))

    def test_roundtrip_response_to_dict(self):
        """SolverResponse.to_dict 往返（与 worker 输出一致）。"""
        from edge_platform.scheduler.cpsat.contract import SolverResponse

        resp = SolverResponse(
            solverVersion="cpsat-v1",
            solverStatus="UNAVAILABLE",
            solveDurationMs=0,
            objective=0.0,
            unassignedTaskIds=["t1"],
        )
        d = resp.to_dict()
        self.assertEqual(d["solverStatus"], "UNAVAILABLE")
        self.assertEqual(d["unassignedTaskIds"], ["t1"])

    # ---- P0-4：权威 RouteCost 矩阵 travel 目标 ----

    def test_travel_cost_uses_matrix_value(self):
        """矩阵传入后 travel 目标使用矩阵 distanceMeters（而非坐标欧氏）。"""
        req = SolverRequest.from_dict(
            {
                **_base_request([]),
                "candidateCosts": [
                    {
                        "taskId": "t1",
                        "personId": "p1",
                        "stationId": "s1",
                        "distanceMeters": 120.5,
                        "etaSeconds": 60,
                        "dataQuality": "FRESH",
                        "fallbackReason": None,
                    }
                ],
            }
        )
        v = travel_cost_for_candidate(req.candidateCosts, "t1", "p1", "s1")
        self.assertEqual(v, 120.5)

    def test_travel_cost_missing_candidate_returns_none(self):
        """矩阵缺失该候选 → None（fail-safe，该项不参与目标，绝不回退欧氏）。"""
        req = SolverRequest.from_dict(
            {
                **_base_request([]),
                "candidateCosts": [
                    {
                        "taskId": "t1",
                        "personId": "p1",
                        "stationId": "s1",
                        "distanceMeters": 120.5,
                        "etaSeconds": 60,
                        "dataQuality": "FRESH",
                        "fallbackReason": None,
                    }
                ],
            }
        )
        self.assertIsNone(
            travel_cost_for_candidate(req.candidateCosts, "t2", "p1", "s1")
        )
        self.assertIsNone(
            travel_cost_for_candidate(req.candidateCosts, "t1", "p9", "s1")
        )
        # 无矩阵 → None
        self.assertIsNone(travel_cost_for_candidate([], "t1", "p1", "s1"))

    def test_travel_cost_station_matching(self):
        """stationId 参与匹配；null station 独立键。"""
        req = SolverRequest.from_dict(
            {
                **_base_request([]),
                "candidateCosts": [
                    {
                        "taskId": "t1",
                        "personId": "p1",
                        "stationId": None,
                        "distanceMeters": 5.0,
                        "etaSeconds": 3,
                        "dataQuality": "UNKNOWN",
                        "fallbackReason": "coords_unknown",
                    }
                ],
            }
        )
        self.assertEqual(
            travel_cost_for_candidate(req.candidateCosts, "t1", "p1", None), 5.0
        )
        self.assertIsNone(
            travel_cost_for_candidate(req.candidateCosts, "t1", "p1", "s1")
        )


if __name__ == "__main__":
    unittest.main()
