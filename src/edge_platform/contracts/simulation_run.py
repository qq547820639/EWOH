"""Canonical Simulation Run 契约（ADR-025 / NO-12a，§13 Digital Twin Simulation）。

权威契约：contracts/simulation/simulation-run.schema.json +
simulation-run.test-vectors.json。锁定注册表必须与 schema 一致，由
scripts/audit-domain-contracts.js simulation 域门禁强制。

语义（§13 + ADR-025）：
- kind ∈ 封闭注册表 {what_if, capacity, layout, material_flow}——v1 四类
  全部具备确定性评估器，绝不注册无引擎空类型（§33/§36）；
- status ∈ {created, running, completed, failed}；
- 隔离强制：record.isSimulation 必须 true（§13 模拟数据显式标记的契约面，
  配合 standalone_044 表级 CHECK 与绝不写生产 World State 表三层强制）；
- baseRef 必填（snapshotVersion ≥ 0 整数）——仿真从什么状态改了什么可追溯；
- completed 必须带 results 对象；failed 必须带非空 failureReason（§33 不静默）；
- auditTrail 必须 true。

另含四类确定性评估器（纯函数，零第三方依赖，pyproject dependencies=[]），
与 ewoh-spark-app/shared/simulation-run.ts 逐项一致（Golden #19 共享向量约束）：
- evaluate_what_if(trace_id, base_facts, delta_facts) → 推理结论差集；
- evaluate_capacity(stations, demand_per_hour) → 瓶颈 + 线产能 + 利用率；
- evaluate_layout(stations, moves) → 总行程距离 + 每路径明细；
- evaluate_material_flow(stations) → 瓶颈 + 载荷比列表。
"""

from __future__ import annotations

import math
from typing import Any

KINDS: tuple[str, ...] = ("what_if", "capacity", "layout", "material_flow")
STATUSES: tuple[str, ...] = ("created", "running", "completed", "failed")

_REQUIRED_FIELDS = (
    "runId",
    "kind",
    "status",
    "isSimulation",
    "baseRef",
    "parameters",
    "engineVersion",
    "auditTrail",
)


def validate_simulation_run(record: Any) -> list[str]:
    """校验仿真运行记录；返回错误码列表（空 = 合法）。fail-closed。"""
    if not isinstance(record, dict):
        return ["record_must_be_object"]
    for field in _REQUIRED_FIELDS:
        if field not in record:
            return [f"missing_field:{field}"]
    if not isinstance(record["runId"], str) or not record["runId"].strip():
        return ["bad_run_id"]
    if record["kind"] not in KINDS:
        return ["unknown_kind"]
    if record["status"] not in STATUSES:
        return ["unknown_status"]
    if record["isSimulation"] is not True:
        return ["isolation_required"]
    base_ref = record["baseRef"]
    if not isinstance(base_ref, dict):
        return ["bad_base_ref"]
    snapshot = base_ref.get("snapshotVersion")
    if not isinstance(snapshot, int) or isinstance(snapshot, bool) or snapshot < 0:
        return ["bad_base_ref"]
    scenario_id = base_ref.get("scenarioId")
    if scenario_id is not None and not isinstance(scenario_id, str):
        return ["bad_base_ref"]
    if not isinstance(record["parameters"], dict):
        return ["bad_parameters"]
    if record["status"] == "completed":
        if not isinstance(record.get("results"), dict):
            return ["results_required"]
    if record["status"] == "failed":
        reason_text = record.get("failureReason")
        if not isinstance(reason_text, str) or not reason_text.strip():
            return ["failure_reason_required"]
    engine = record["engineVersion"]
    if not isinstance(engine, str) or not engine.strip():
        return ["bad_engine_version"]
    if record["auditTrail"] is not True:
        return ["audit_required"]
    return []


# ---------------------------------------------------------------------------
# 确定性评估器（ADR-025 §评估器矩阵；与 TS simulation-run.ts 逐项一致）
# ---------------------------------------------------------------------------


def evaluate_what_if(trace_id: str, base_facts: list[Any], delta_facts: list[Any]) -> dict[str, Any]:
    """What-if 评估：对比 base 与 scenario（delta）推理结论的差集。

    单事实对象须含 ruleId/subjectId/conclusion/confidence；结论标识键为
    (ruleId, subjectId, conclusion)。返回 added/removed/changed + 计数。
    与 TS 端排序约定一致（按标识键字典序），保证跨语言仲裁逐字节可比。
    """
    if not isinstance(base_facts, list) or not isinstance(delta_facts, list):
        raise ValueError("base_facts/delta_facts 必须是列表")
    base_concl = _collect_conclusions(base_facts)
    scen_concl = _collect_conclusions(delta_facts)
    base_keys = set(base_concl)
    scen_keys = set(scen_concl)

    def _sorted_entries(keys, concl):
        return [concl[k] for k in sorted(keys)]

    added = _sorted_entries(scen_keys - base_keys, scen_concl)
    removed = _sorted_entries(base_keys - scen_keys, base_concl)
    changed: list[Any] = []
    for key in sorted(base_keys & scen_keys):
        if base_concl[key]["confidence"] != scen_concl[key]["confidence"]:
            changed.append(
                {
                    "ruleId": key[0],
                    "subjectId": key[1],
                    "conclusion": key[2],
                    "baseConfidence": base_concl[key]["confidence"],
                    "scenarioConfidence": scen_concl[key]["confidence"],
                }
            )
    return {
        "traceId": trace_id,
        "baseCount": len(base_concl),
        "scenarioCount": len(scen_concl),
        "added": added,
        "removed": removed,
        "changed": changed,
    }


def _collect_conclusions(facts: list[Any]) -> dict[tuple[str, str, str], dict[str, Any]]:
    result: dict[tuple[str, str, str], dict[str, Any]] = {}
    for fact in facts:
        if not isinstance(fact, dict):
            raise ValueError("fact 必须是对象")
        rule_id = fact.get("ruleId")
        subject_id = fact.get("subjectId")
        conclusion = fact.get("conclusion")
        if not isinstance(rule_id, str) or not isinstance(subject_id, str) or not isinstance(conclusion, str):
            raise ValueError("fact 须含字符串 ruleId/subjectId/conclusion")
        confidence = fact.get("confidence")
        # R2-SHR-003：数值入口统一补 isfinite（对齐 TS Number.isFinite）。
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not math.isfinite(confidence):
            raise ValueError("fact.confidence 必须是数值")
        key = (rule_id, subject_id, conclusion)
        result[key] = {
            "ruleId": rule_id,
            "subjectId": subject_id,
            "conclusion": conclusion,
            "confidence": float(confidence),
        }
    return result


def evaluate_capacity(stations: list[Any], demand_per_hour: float) -> dict[str, Any]:
    """容量评估：求瓶颈工位与线产能（每分钟瓶颈吞吐）。

    stations: [{stationId, capacityPerHour}]；demand_per_hour > 0 必须。
    公式（TS 端一致）：line_throughput = min(capacity)；utilization =
    demand / line_throughput；overloaded = utilization > 1。
    """
    if not isinstance(stations, list) or not stations:
        raise ValueError("stations 必须是非空列表")
    if (
        isinstance(demand_per_hour, bool)
        or not isinstance(demand_per_hour, (int, float))
        or not math.isfinite(demand_per_hour)
    ):
        raise ValueError("demandPerHour 必须是数值")
    if demand_per_hour <= 0:
        raise ValueError("demandPerHour 必须 > 0")
    normalized = []
    for station in stations:
        if not isinstance(station, dict):
            raise ValueError("station 必须是对象")
        station_id = station.get("stationId")
        capacity = station.get("capacityPerHour")
        if not isinstance(station_id, str) or not station_id:
            raise ValueError("station.stationId 必须是非空字符串")
        if isinstance(capacity, bool) or not isinstance(capacity, (int, float)) or not math.isfinite(capacity):
            raise ValueError("station.capacityPerHour 必须是数值")
        if capacity <= 0:
            raise ValueError("station.capacityPerHour 必须 > 0")
        normalized.append({"stationId": station_id, "capacityPerHour": float(capacity)})
    line_throughput = min(s["capacityPerHour"] for s in normalized)
    bottleneck = next(s["stationId"] for s in normalized if s["capacityPerHour"] == line_throughput)
    utilization = round(float(demand_per_hour) / line_throughput, 6)
    return {
        "bottleneckStationId": bottleneck,
        "lineThroughputPerHour": line_throughput,
        "utilization": utilization,
        "overloaded": utilization > 1.0,
    }


def evaluate_layout(stations: list[Any], moves: list[Any]) -> dict[str, Any]:
    """布局评估：物料搬运总行程（欧氏距离 × 趟次）。

    stations: [{stationId, x, y}]；moves: [{fromStationId, toStationId, trips}]。
    未知工位 fail-closed；trips 必须 ≥ 1 整数；结果四舍五入 6 位保证
    跨语言浮点逐字节一致。
    """
    if not isinstance(stations, list) or not stations:
        raise ValueError("stations 必须是非空列表")
    if not isinstance(moves, list):
        raise ValueError("moves 必须是列表")
    coords: dict[str, tuple[float, float]] = {}
    for station in stations:
        if not isinstance(station, dict):
            raise ValueError("station 必须是对象")
        station_id = station.get("stationId")
        x = station.get("x")
        y = station.get("y")
        if not isinstance(station_id, str) or not station_id:
            raise ValueError("station.stationId 必须是非空字符串")
        if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x):
            raise ValueError("station.x 必须是数值")
        if isinstance(y, bool) or not isinstance(y, (int, float)) or not math.isfinite(y):
            raise ValueError("station.y 必须是数值")
        coords[station_id] = (float(x), float(y))
    routes = []
    total = 0.0
    for move in moves:
        if not isinstance(move, dict):
            raise ValueError("move 必须是对象")
        from_id = move.get("fromStationId")
        to_id = move.get("toStationId")
        trips = move.get("trips")
        if from_id not in coords or to_id not in coords:
            raise ValueError(f"未知工位：{from_id!r} / {to_id!r}")
        if isinstance(trips, bool) or not isinstance(trips, int) or trips < 1:
            raise ValueError("move.trips 必须是 ≥1 整数")
        (x1, y1) = coords[from_id]
        (x2, y2) = coords[to_id]
        distance = round(((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5, 6)
        weighted = round(distance * trips, 6)
        total = round(total + weighted, 6)
        routes.append(
            {
                "fromStationId": from_id,
                "toStationId": to_id,
                "distance": round(distance, 6),
                "trips": trips,
                "totalDistance": weighted,
            }
        )
    return {"totalTravelDistance": total, "routes": routes}


def evaluate_material_flow(stations: list[Any]) -> dict[str, Any]:
    """物料流评估：载荷比 = inflow / capacity；瓶颈 = 最大载荷比工位。

    stations: [{stationId, capacityPerHour, inflowPerHour}]。载荷比四舍五入
    6 位；>1 即过载。并列最大值取先出现工位（TS 端一致）。
    """
    if not isinstance(stations, list) or not stations:
        raise ValueError("stations 必须是非空列表")
    normalized = []
    for station in stations:
        if not isinstance(station, dict):
            raise ValueError("station 必须是对象")
        station_id = station.get("stationId")
        capacity = station.get("capacityPerHour")
        inflow = station.get("inflowPerHour")
        if not isinstance(station_id, str) or not station_id:
            raise ValueError("station.stationId 必须是非空字符串")
        if isinstance(capacity, bool) or not isinstance(capacity, (int, float)) or not math.isfinite(capacity):
            raise ValueError("station.capacityPerHour 必须是数值")
        if capacity <= 0:
            raise ValueError("station.capacityPerHour 必须 > 0")
        if isinstance(inflow, bool) or not isinstance(inflow, (int, float)) or not math.isfinite(inflow):
            raise ValueError("station.inflowPerHour 必须是数值")
        if inflow < 0:
            raise ValueError("station.inflowPerHour 必须 ≥ 0")
        load_ratio = round(float(inflow) / float(capacity), 6)
        normalized.append(
            {
                "stationId": station_id,
                "loadRatio": load_ratio,
                "overloaded": load_ratio > 1.0,
            }
        )
    bottleneck = max(normalized, key=lambda s: s["loadRatio"])
    return {
        "bottleneckStationId": bottleneck["stationId"],
        "bottleneckLoadRatio": bottleneck["loadRatio"],
        "stations": normalized,
    }
