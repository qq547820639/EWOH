"""Golden Scheduler Workflow TCK（Phase 7 / NO-07b，Python 执行器 / 独立仲裁）。

与 TS 侧 golden-scheduler-workflow.spec.ts 消费同一份共享场景定义
（tests/golden-fixtures/scheduler-workflow-golden.json）与同一份操作结果
（scheduler-workflow-golden-results.json，TS 真实服务在状态化替身上产出，
漂移门禁）：

- 本文件用标准库**重实现工作流不变量**（plan 版本 CAS / 快照新鲜度拒绝 /
  审批后 assignment 状态收敛 / 资源预约重叠冲突 capacity=1 / 派工前置条件
  approved + dispatched 状态收敛 + outbox 事件），逐操作重放场景并比对提交
  结果——不依赖 ortools、不依赖 TS 运行时。

运行：python3 -m pytest tests/test_golden_scheduler_workflow.py -q
"""

from __future__ import annotations

import json
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent / "golden-fixtures"
SCENARIOS_PATH = FIXTURES / "scheduler-workflow-golden.json"
RESULTS_PATH = FIXTURES / "scheduler-workflow-golden-results.json"


def _overlaps(a_start, a_end, b_start, b_end) -> bool:
    return a_start < b_end and b_start < a_end


def _derive(scenario) -> list[dict]:
    """标准库重放：plan 状态机 + 预约冲突 + 派工前置 + 反馈回流 + 重排 supersede，
    产出与 TS 同形的 outcome 序列。"""
    plan = {"status": "shadow", "version": 1}
    # 每个场景独立初始化（plan 状态来自 seed 首行）。
    seed_plans = scenario["seed"]["plans"]
    if seed_plans:
        first = seed_plans[0]
        plan = {
            "status": first.get("status", "shadow"),
            "version": first.get("version", 1),
        }
    assignment_statuses = [s.get("status", "shadow") for s in scenario["seed"]["assignments"]]
    reservations: list[dict] = []
    outbox: list[str] = []
    outcomes: list[dict] = []
    # 场景 2：执行反馈行（recordActuals 的写入事实）。
    feedback_rows: list[str] = []

    for entry in scenario["ops"]:
        op = entry["op"]
        params = entry["params"]
        if op == "approve":
            if params["version"] != plan["version"]:
                outcomes.append({"op": "approve", "outcome": {"ok": False, "reason": "PLAN_STALE"}})
                # 观测型副作用：stale 通知（与 TS notifyStalePlan 对应）。
                outbox.append("stale_plan")
                continue
            if params.get("staleSnapshot"):
                outcomes.append({"op": "approve", "outcome": {"ok": False, "reason": "PLAN_STALE"}})
                outbox.append("stale_plan")
                continue
            plan["status"] = "approved"
            assignment_statuses = ["approved"] * len(assignment_statuses)
            outcomes.append(
                {
                    "op": "approve",
                    "outcome": {
                        "ok": True,
                        "planStatus": plan["status"],
                        "assignmentStatuses": list(assignment_statuses),
                    },
                }
            )
        elif op == "reserve":
            conflict = any(
                r["resourceId"] == params["resourceId"]
                and _overlaps(
                    r["startMs"], r["endMs"], params["startMs"], params["endMs"]
                )
                for r in reservations
            )
            if conflict:
                outcomes.append(
                    {"op": "reserve", "outcome": {"ok": False, "reason": "RESOURCE_CONFLICT"}}
                )
            else:
                reservations.append(
                    {
                        "resourceId": params["resourceId"],
                        "startMs": params["startMs"],
                        "endMs": params["endMs"],
                    }
                )
                outcomes.append(
                    {"op": "reserve", "outcome": {"ok": True, "reservationIdPrefix": "RSV-"}}
                )
        elif op == "dispatch":
            if plan["status"] != "approved":
                outcomes.append(
                    {"op": "dispatch", "outcome": {"ok": False, "reason": "PLAN_NOT_APPROVED"}}
                )
                continue
            plan["status"] = "dispatched"
            assignment_statuses = ["dispatched"] * len(assignment_statuses)
            outbox.extend(["assignment.dispatched", "plan.dispatched"])
            outcomes.append(
                {
                    "op": "dispatch",
                    "outcome": {
                        "ok": True,
                        "planStatus": plan["status"],
                        "assignmentStatuses": list(assignment_statuses),
                        "outboxEvents": list(outbox),
                    },
                }
            )
        elif op == "feedback":
            # 执行反馈回流：按 (planId, assignmentId, taskId) 写反馈事实（幂等覆盖）。
            key = f"{params['planId']}|{params['assignmentId']}|{params['taskId']}"
            feedback_rows.append(key)
            outcomes.append({"op": "feedback", "outcome": {"ok": True}})
        elif op == "replan":
            # 事件驱动重排：版本 +1、新 planId = {planId}-R{newVersion}、
            # 旧方案 superseded 并指向新方案；新方案携带场景快照中的任务分配
            # （TS 侧真实求解器对 TASK-2 的唯一可行解是 p1 手工）。
            new_version = plan["version"] + 1
            new_plan_id = f"{params['planId']}-R{new_version}"
            old_status = plan["status"]
            plan = {"status": "shadow", "version": new_version}
            task_ids = sorted(
                {a.get("taskId") for a in scenario["seed"]["assignments"] if a.get("taskId")}
            )
            outcomes.append(
                {
                    "op": "replan",
                    "outcome": {
                        "ok": True,
                        "newPlanId": new_plan_id,
                        "newVersion": new_version,
                        "oldPlanStatus": "superseded",
                        "supersededBy": new_plan_id,
                        "newAssignments": task_ids,
                    },
                }
            )
            # 旧方案被 supersede 后，审批目标切到新方案（场景 2 的 approve_new）。
            plan["_planId"] = new_plan_id
        else:
            raise AssertionError(f"unhandled op: {op}")
    return outcomes


def _load():
    scenarios = json.loads(SCENARIOS_PATH.read_text(encoding="utf-8"))
    results = json.loads(RESULTS_PATH.read_text(encoding="utf-8"))
    return scenarios, results


def test_scenario_declarations():
    scenarios, _ = _load()
    assert scenarios["schemaVersion"] == "1.0.0"
    assert [s["id"] for s in scenarios["scenarios"]] == [
        "plan_lifecycle_cas_reserve_dispatch",
        "execution_feedback_and_replan",
    ]


def test_workflow_invariants_replay_matches_results():
    """独立仲裁：标准库重放与 TS 提交结果逐操作一致。"""
    scenarios, results = _load()
    by_id = {r["scenarioId"]: r for r in results}
    for scenario in scenarios["scenarios"]:
        derived = _derive(scenario)
        committed = by_id[scenario["id"]]["ops"]
        assert len(derived) == len(committed), scenario["id"]
        for i, (want, got) in enumerate(zip(derived, committed)):
            assert want["op"] == got["op"], (scenario["id"], i)
            # outboxEvents：仅断言包含关系与 stale_plan 计数（观测型副作用），
            # 其余字段必须逐项一致。
            if "outboxEvents" in want["outcome"]:
                got_outbox = got["outcome"].get("outboxEvents") or []
                assert set(want["outcome"]["outboxEvents"]) <= set(got_outbox), (
                    scenario["id"],
                    i,
                    want["outcome"]["outboxEvents"],
                    got_outbox,
                )
                assert got_outbox.count("stale_plan") == want["outcome"]["outboxEvents"].count(
                    "stale_plan"
                ), (scenario["id"], i)
                rest_want = {k: v for k, v in want["outcome"].items() if k != "outboxEvents"}
                rest_got = {k: v for k, v in got["outcome"].items() if k != "outboxEvents"}
                assert rest_want == rest_got, (scenario["id"], i)
            else:
                assert want["outcome"] == got["outcome"], (scenario["id"], i)


def test_workflow_expectations_hold():
    """场景期望（fixture 内声明）必须与提交结果一致。"""
    scenarios, results = _load()
    by_id = {r["scenarioId"]: r for r in results}
    for scenario in scenarios["scenarios"]:
        ops = by_id[scenario["id"]]["ops"]
        assert len(ops) == len(scenario["ops"]), scenario["id"]
        for op_entry, result_entry in zip(scenario["ops"], ops):
            key = op_entry["expectKey"]
            exp = scenario["expect"][key]
            outcome = result_entry["outcome"]
            if "outboxEvents" in exp:
                got_outbox = outcome.get("outboxEvents") or []
                assert set(exp["outboxEvents"]) <= set(got_outbox), (scenario["id"], key)
                for field in ("ok", "planStatus", "assignmentStatuses"):
                    assert outcome.get(field) == exp.get(field), (scenario["id"], key, field)
            elif "reservationIdPrefix" in exp:
                assert outcome.get("ok") is True, (scenario["id"], key)
                assert str(outcome.get("reservationIdPrefix", "")).startswith(
                    exp["reservationIdPrefix"]
                ), (scenario["id"], key)
            else:
                for field, value in exp.items():
                    if field == "newAssignments":
                        assert outcome.get(field) == value, (scenario["id"], key, field)
                    else:
                        assert outcome.get(field) == value, (scenario["id"], key, field)
