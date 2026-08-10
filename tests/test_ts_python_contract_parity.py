"""TS↔Python 调度契约 golden fixture parity 测试（.trae/specs/scheduler-prod-convergence Task 3）。

同一份 golden JSON（tests/golden-fixtures/scheduler-contract.golden.json）：
- 本文件（pytest）：验证 SolverRequest.from_dict / SolverResponse.to_dict 与 golden 深等、
  solverStatusValues 与契约允许值集合一致、golden 每个 key 都能被 from_dict 接受；
- TS 侧（ewoh-spark-app/server/modules/scheduler/__tests__/solver-contract-parity.spec.ts）：
  验证顶层 key 集合与 SolverStatus 枚举覆盖。

仅依赖标准库 + contract.py（contract.py 无 ortools 依赖，可独立运行）：
    python3 -m pytest tests/test_ts_python_contract_parity.py -v
"""

from __future__ import annotations

import dataclasses
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from edge_platform.scheduler.cpsat.contract import (  # noqa: E402
    SolverAssignmentResult,
    SolverRequest,
    SolverResponse,
    SolverWeights,
)

GOLDEN_PATH = Path(__file__).parent / "golden-fixtures" / "scheduler-contract.golden.json"

with GOLDEN_PATH.open("r", encoding="utf-8") as _fh:
    GOLDEN = json.load(_fh)

# 契约允许的 solverStatus 值集合（与 shared/scheduler.ts SolverStatus 联合一一对应）。
SOLVER_STATUSES = {
    "OPTIMAL",
    "FEASIBLE",
    "HEURISTIC",
    "FALLBACK",
    "INFEASIBLE",
    "TIMEOUT",
    "UNAVAILABLE",
}


def _assert_flat(obj, data):
    """dataclass 字段名即 JSON key：断言 obj 的每个字段值与 golden 条目一致。"""
    for f in dataclasses.fields(obj):
        assert getattr(obj, f.name) == data[f.name], f"字段 {f.name} 不匹配"


def test_request_from_dict_accepts_all_golden_keys():
    # from_dict 逐 key 解析：golden 的每个 key 都必须被接受（不抛）。
    req = SolverRequest.from_dict(GOLDEN["request"])
    assert isinstance(req, SolverRequest)


def test_request_from_dict_roundtrip():
    req = SolverRequest.from_dict(GOLDEN["request"])
    g = GOLDEN["request"]

    for f in (
        "requestId",
        "snapshotVersion",
        "policyVersion",
        "solverVersion",
        "horizonMinutes",
        "nowMs",
        "forbiddenZones",
        "safetyBlockedPersonIds",
        "safetyBlockedDeviceIds",
        "baselineAssignee",
        "timeLimitMs",
    ):
        assert getattr(req, f) == g[f], f"字段 {f} 不匹配"

    # weights：golden 只含 TS 侧 8 项；unassignedPenalty 为 Python 缺省默认（golden 不含）。
    assert isinstance(req.weights, SolverWeights)
    for f in (
        "lateness",
        "travel",
        "workloadBalance",
        "stationWait",
        "changeCost",
        "risk",
        "energyRisk",
        "churn",
    ):
        assert getattr(req.weights, f) == g["weights"][f], f"weights.{f} 不匹配"
    assert req.weights.unassignedPenalty == 1000.0

    assert len(req.tasks) == len(g["tasks"])
    for t, gt in zip(req.tasks, g["tasks"]):
        _assert_flat(t, gt)
    assert len(req.persons) == len(g["persons"])
    for p, gp in zip(req.persons, g["persons"]):
        _assert_flat(p, gp)
    assert len(req.devices) == len(g["devices"])
    for d, gd in zip(req.devices, g["devices"]):
        _assert_flat(d, gd)
    assert len(req.stations) == len(g["stations"])
    for s, gs in zip(req.stations, g["stations"]):
        _assert_flat(s, gs)
    assert len(req.reservations) == len(g["reservations"])
    for r, gr in zip(req.reservations, g["reservations"]):
        _assert_flat(r, gr)
    assert len(req.frozenAssignments) == len(g["frozenAssignments"])
    for fa, gfa in zip(req.frozenAssignments, g["frozenAssignments"]):
        _assert_flat(fa, gfa)
    assert len(req.candidateCosts) == len(g["candidateCosts"])
    for c, gc in zip(req.candidateCosts, g["candidateCosts"]):
        _assert_flat(c, gc)


def test_no_unknown_request_keys_for_python_contract():
    known = set(SolverRequest.__dataclass_fields__)
    extra = set(GOLDEN["request"].keys()) - known
    # constraints 为 TS 侧透传（SchedulingConstraint 扁平记录；contract.py 无对应 dataclass
    # 字段，from_dict 显式忽略）——它是 golden 中唯一不在 contract.py 上的 key，其余必须全对齐。
    assert extra == {"constraints"}, f"存在 Python 侧未知字段: {extra}"


def test_response_to_dict_roundtrip():
    resp_data = GOLDEN["response"]
    assignments = [SolverAssignmentResult(**a) for a in resp_data["assignments"]]
    resp = SolverResponse(
        **{k: v for k, v in resp_data.items() if k != "assignments"},
        assignments=assignments,
    )
    assert resp.to_dict() == resp_data


def test_solver_status_values_match_contract():
    assert set(GOLDEN["solverStatusValues"]) == SOLVER_STATUSES
    assert len(GOLDEN["solverStatusValues"]) == len(set(GOLDEN["solverStatusValues"]))
    # golden 样例的 response.solverStatus 必须落在契约集合内。
    assert GOLDEN["response"]["solverStatus"] in SOLVER_STATUSES
