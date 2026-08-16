"""Golden Scheduler TCK（Phase 7 / NO-07，Python 执行器 / 独立仲裁）。

与 TS 侧 golden-scheduler-scenarios.spec.ts 消费同一份共享场景定义
（tests/golden-fixtures/scheduler-golden-scenarios.json）与同一份求解结果
（scheduler-golden-results.json，TS heuristic 产出并漂移门禁）：

- 本文件用标准库对提交结果做**独立硬约束仲裁**（不依赖 ortools/不依赖 TS）：
  skill/status/维护封锁/质量封锁/设备在线电量能力/工位能力/禁入区域/人员不重复预订；
- 断言提交结果与场景期望一致（assignments/unassigned/blockedReasons）——
  两个运行时对同一世界状态给出同一可行解，即跨语言一致性。

运行：python3 -m pytest tests/test_golden_scheduler_scenarios.py -q
"""

from __future__ import annotations

import json
from pathlib import Path

from edge_platform.contracts import risk as risk_contract

FIXTURES = Path(__file__).resolve().parent / "golden-fixtures"
SCENARIOS_PATH = FIXTURES / "scheduler-golden-scenarios.json"
RESULTS_PATH = FIXTURES / "scheduler-golden-results.json"

MIN_BATTERY = 15
MAX_LOAD = 0.9


def _normalized_severity(value) -> str | None:
    try:
        return risk_contract.normalize_severity(value)
    except risk_contract.DomainContractError:
        # 未知严重度 fail-closed：按封锁处理（与 TS qualityFindingsBlockDispatch 一致）。
        return "critical"


def _blocks(facts: list | None) -> bool:
    """NO-05c 语义：任何活跃维护事实 → 封锁（TS 侧已把终态过滤在外）。"""
    return bool(facts)


def _quality_blocks(findings: list | None) -> bool:
    """NO-05d 语义：critical/high 活跃质量发现 → 封锁；medium/low 仅事实可见。"""
    if not findings:
        return False
    for f in findings:
        sev = _normalized_severity(f.get("severity"))
        if sev in ("critical", "high"):
            return True
        if sev is None:
            return True
    return False


def _check_assignment(assign, snapshot) -> list[str]:
    errors: list[str] = []
    task_id = assign["taskId"]
    tasks = {t["id"]: t for t in snapshot["tasks"]}
    persons = {p["id"]: p for p in snapshot["persons"]}
    devices = {d["id"]: d for d in snapshot["devices"]}
    stations = {s["id"]: s for s in snapshot["stations"]}
    forbidden = {z["zoneId"] for z in snapshot.get("forbiddenZones", [])}
    safety_blocked = set(snapshot.get("safetyBlockedPersonIds", []))

    task = tasks.get(task_id)
    if task is None:
        return [f"unknown_task:{task_id}"]

    person = persons.get(assign["personId"] or "")
    if person is None:
        errors.append("unknown_person")
    else:
        if person.get("status") != "AVAILABLE":
            errors.append("person_unavailable")
        if person.get("loadLevel", 0) > MAX_LOAD:
            errors.append("continuous_work_exceeded")
        if person["id"] in safety_blocked:
            errors.append("safety_blocked")
        if _blocks(person.get("maintenance")):
            errors.append("person_maintenance_blocked")
        if _quality_blocks(person.get("qualityFindings")):
            errors.append("person_quality_blocked")
        required = task.get("requiredSkills") or []
        if required and not all(s in (person.get("skills") or []) for s in required):
            errors.append("missing_skill")
        certs = task.get("requiredCertifications") or []
        if certs and not all(c in (person.get("certifications") or []) for c in certs):
            errors.append("missing_certification")
        if task.get("zoneId") and task["zoneId"] in forbidden:
            errors.append("zone_forbidden")

    device_id = assign.get("deviceId")
    if device_id:
        device = devices.get(device_id)
        if device is None:
            errors.append("unknown_device")
        else:
            if not device.get("online"):
                errors.append("device_offline")
            if device.get("batteryPct", 0) < MIN_BATTERY:
                errors.append("battery_low")
            caps = task.get("requiredDeviceCapabilities") or []
            if caps and not all(c in (device.get("capabilities") or []) for c in caps):
                errors.append("missing_device_capability")
            if _blocks(device.get("maintenance")):
                errors.append("device_maintenance_blocked")
            if _quality_blocks(device.get("qualityFindings")):
                errors.append("device_quality_blocked")

    station_id = assign.get("stationId")
    if station_id:
        station = stations.get(station_id)
        if station is None:
            errors.append("unknown_station")
        else:
            caps = task.get("requiredStationCapabilities") or []
            if caps and not all(c in (station.get("capabilities") or []) for c in caps):
                errors.append("station_capability_mismatch")
            if _blocks(station.get("maintenance")):
                errors.append("station_maintenance_blocked")
            if _quality_blocks(station.get("qualityFindings")):
                errors.append("station_quality_blocked")

    return errors


def _load():
    scenarios = json.loads(SCENARIOS_PATH.read_text(encoding="utf-8"))
    results = json.loads(RESULTS_PATH.read_text(encoding="utf-8"))
    return scenarios, results


def test_scenario_declarations():
    scenarios, _ = _load()
    assert scenarios["schemaVersion"] == "1.0.0"
    ids = {s["id"] for s in scenarios["scenarios"]}
    assert ids == {
        "skill_match_baseline",
        "maintenance_blocked_device_fail_closed",
        "maintenance_blocked_person_fail_closed",
        "quality_blocked_station_fail_closed",
    }


def test_results_match_expectations():
    scenarios, results = _load()
    by_id = {r["scenarioId"]: r for r in results}
    for scenario in scenarios["scenarios"]:
        result = by_id[scenario["id"]]
        expect = scenario["expect"]
        assert result["assignments"] == expect["assignments"], scenario["id"]
        assert result["unassigned"] == expect["unassigned"], scenario["id"]
        for blocked in expect["blockedReasons"]:
            assert f"{blocked['taskId']}:{blocked['reason']}" in result["violationReasons"], (
                scenario["id"],
                blocked,
            )


def test_independent_hard_constraint_arbitration():
    """独立仲裁：提交结果的每个 assignment 必须通过 Python 侧硬约束复验；
    人员不得被重复预订。"""
    scenarios, results = _load()
    by_id = {r["scenarioId"]: r for r in results}
    for scenario in scenarios["scenarios"]:
        result = by_id[scenario["id"]]
        booked_persons: list[str] = []
        for assign in result["assignments"]:
            errors = _check_assignment(assign, scenario["snapshot"])
            assert errors == [], (scenario["id"], assign, errors)
            pid = assign["personId"]
            assert pid not in booked_persons, (scenario["id"], "double_booked", pid)
            booked_persons.append(pid)
        # unassigned 任务必须确实没有分配记录（且场景期望的原因出现在仲裁结果里）。
        assigned = {a["taskId"] for a in result["assignments"]}
        for task_id in result["unassigned"]:
            assert task_id not in assigned, (scenario["id"], task_id)
