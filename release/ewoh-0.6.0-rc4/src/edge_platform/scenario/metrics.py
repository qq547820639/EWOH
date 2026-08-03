"""场景仿真层 — 单方案指标计算。

对应 spec「场景仿真层」：每个方案展示预计产量、延误风险、人员负荷变化、行走距离、
外骨骼电量消耗、拥堵变化、受影响人员、关键假设、置信度。

所有指标均从 ctx 真实输入经文档化简单公式计算，不虚构数值（spec：「大模型不得虚构传感器
数据或调度结果」，本模块同理——指标必须可追溯到 ctx 中的真实状态）。

公式说明（每项均文档化、可解释）：
- estimated_output：sum(任务预期产量 × 人员速度系数)；产能优先方案打包到快人员→产量高。
- on_time_probability：avg(1 − 单任务延误率)；单任务延误率=max(0,预测时长/速度−可用时长)/可用时长。
- delay_risk：min(1, sum(单任务延误率))；延误任务越多风险越高，截断到 0..1。
- high_load_persons：分配后累计负荷（当前负荷 + 任务负荷增量）> 高负荷阈值的人员。
- total_travel_distance_m：sum(distance(人员位姿, 工位位姿))，复用 edge_platform.spatial.distance。
- low_battery_devices：班次末预测电量 < 阈值，或设备故障；预测电量=当前电量−消耗率×剩余小时。
- congestion_delta：sum(新占用人数 − 当前占用人数) 各工位（仅统计方案涉及的工位）。
- affected_persons：分配相对 current_assignment 发生变更的人员。
- confidence：基于人员/工位/任务数据完整度的综合置信度（0..1）。

ctx 契约（dict）：
    persons_state: {person_id: {pose: Pose, current_load: float, speed_factor: float, ...}}
    stations_state: {station_id: {pose: Pose, capacity: int, current_occupancy: int, task_id: str}}
    devices_state: {device_id: {battery_pct: float, drain_per_hour: float, faulty: bool, model: str}}
    tasks_state: {task_id: {predicted_duration_min: float, available_time_min: float,
                            expected_units: float, load_add: float, required_skills: set}}
    shift: {remaining_hours: float, battery_low_threshold: float, load_high_threshold: float}
    current_assignment: {person_id: {station_id, task_id, device_id}}

plan_assignment 契约：{person_id: {station_id, task_id, device_id}}

纯 Python 标准库实现。
"""

from dataclasses import dataclass, field

from edge_platform.spatial import distance


@dataclass
class PlanMetrics:
    """单方案分项指标（spec「场景仿真层」九项展示字段）。"""

    estimated_output: float = 0.0  # 预计产量（单位）
    on_time_probability: float = 0.0  # 准时完成概率 0..1
    delay_risk: float = 0.0  # 延误风险 0..1
    high_load_persons: list = field(default_factory=list)  # 高负荷人员 ID 列表
    total_travel_distance_m: float = 0.0  # 总行走距离（米）
    low_battery_devices: list = field(default_factory=list)  # 低电量/故障设备 ID 列表
    congestion_delta: float = 0.0  # 工位拥堵变化（有符号）
    affected_persons: list = field(default_factory=list)  # 受影响人员 ID 列表
    key_assumptions: dict = field(default_factory=dict)  # 关键假设与公式说明
    confidence: float = 0.0  # 置信度 0..1

    def to_dict(self):
        return {
            "estimated_output": self.estimated_output,
            "on_time_probability": self.on_time_probability,
            "delay_risk": self.delay_risk,
            "high_load_persons": list(self.high_load_persons),
            "total_travel_distance_m": self.total_travel_distance_m,
            "low_battery_devices": list(self.low_battery_devices),
            "congestion_delta": self.congestion_delta,
            "affected_persons": list(self.affected_persons),
            "key_assumptions": dict(self.key_assumptions),
            "confidence": self.confidence,
        }


def compute_metrics(plan_assignment, ctx):
    """计算单方案分项指标。所有指标从 ctx 真实值经文档化公式计算。

    plan_assignment: {person_id: {station_id, task_id, device_id}}
    ctx: 见模块文档（persons_state / stations_state / devices_state / tasks_state /
          shift / current_assignment）。
    """
    ctx = ctx or {}
    persons_state = ctx.get("persons_state", {}) or {}
    stations_state = ctx.get("stations_state", {}) or {}
    devices_state = ctx.get("devices_state", {}) or {}
    tasks_state = ctx.get("tasks_state", {}) or {}
    shift = ctx.get("shift", {}) or {}
    current_assignment = ctx.get("current_assignment", {}) or {}

    load_high_threshold = float(shift.get("load_high_threshold", 0.8))
    battery_low_threshold = float(shift.get("battery_low_threshold", 0.2))
    remaining_hours = float(shift.get("remaining_hours", 4.0))

    estimated_output = 0.0
    delay_risk_sum = 0.0
    on_time_probs = []
    high_load_persons = []
    total_travel = 0.0
    affected_persons = []
    per_station_new_occupancy = {}
    confidence_factors = []
    assumptions = {}

    for person_id, assignment in (plan_assignment or {}).items():
        assignment = assignment or {}
        station_id = assignment.get("station_id", "")
        task_id = assignment.get("task_id", "")
        device_id = assignment.get("device_id", "")

        pstate = persons_state.get(person_id, {}) or {}
        sstate = stations_state.get(station_id, {}) or {}
        tstate = tasks_state.get(task_id, {}) or {}

        # 预计产量 = 任务预期产量 × 人员速度系数
        expected_units = float(tstate.get("expected_units", 0.0) or 0.0)
        speed_factor = float(pstate.get("speed_factor", 1.0) or 1.0)
        estimated_output += expected_units * speed_factor

        # 延误风险与准时率（单任务延误率，速度系数折算预测时长）
        predicted_duration = float(tstate.get("predicted_duration_min", 0.0) or 0.0) / max(speed_factor, 1e-9)
        available_time = float(tstate.get("available_time_min", 0.0) or 0.0)
        if available_time > 1e-9:
            task_delay = max(0.0, predicted_duration - available_time) / available_time
        else:
            task_delay = 1.0 if predicted_duration > 1e-9 else 0.0
        delay_risk_sum += task_delay
        on_time_probs.append(max(0.0, 1.0 - task_delay))

        # 高负荷人员：当前负荷 + 任务负荷增量 > 阈值
        current_load = float(pstate.get("current_load", 0.0) or 0.0)
        load_add = float(tstate.get("load_add", 0.0) or 0.0)
        new_load = current_load + load_add
        if new_load > load_high_threshold + 1e-9:
            high_load_persons.append(person_id)

        # 行走距离：复用 edge_platform.spatial.distance（XY 欧氏距离，米）
        person_pose = pstate.get("pose")
        station_pose = sstate.get("pose")
        if person_pose is not None and station_pose is not None:
            try:
                total_travel += float(distance(person_pose, station_pose))
            except (TypeError, AttributeError):
                pass

        # 受影响人员：与当前分配在工位/任务/设备任一项上不同
        cur = current_assignment.get(person_id, {}) or {}
        if cur.get("station_id") != station_id or cur.get("task_id") != task_id or cur.get("device_id") != device_id:
            affected_persons.append(person_id)

        # 工位新占用人数计数（用于拥堵变化）
        per_station_new_occupancy[station_id] = per_station_new_occupancy.get(station_id, 0) + 1

        # 置信度因子：人员/工位/任务数据是否齐全
        data_ok = bool(pstate and sstate and tstate)
        confidence_factors.append(1.0 if data_ok else 0.5)

    # 低电量/故障设备（仅统计方案中分配到的设备）
    low_battery_devices = []
    assigned_device_set = {a.get("device_id", "") for a in (plan_assignment or {}).values() if a and a.get("device_id")}
    for device_id in assigned_device_set:
        dstate = devices_state.get(device_id, {}) or {}
        if dstate.get("faulty"):
            low_battery_devices.append(device_id)
            continue
        battery = float(dstate.get("battery_pct", 1.0) or 1.0)
        drain = float(dstate.get("drain_per_hour", 0.0) or 0.0)
        predicted_battery = battery - drain * remaining_hours
        if predicted_battery < battery_low_threshold + 1e-9:
            low_battery_devices.append(device_id)

    # 拥堵变化 = sum(新占用人数 − 当前占用人数) 各方案涉及工位
    congestion_delta = 0.0
    for station_id, new_occ in per_station_new_occupancy.items():
        cur_occ = int((stations_state.get(station_id, {}) or {}).get("current_occupancy", 0) or 0)
        congestion_delta += new_occ - cur_occ

    # 聚合
    on_time_probability = sum(on_time_probs) / len(on_time_probs) if on_time_probs else 1.0
    on_time_probability = max(0.0, min(1.0, on_time_probability))
    delay_risk = max(0.0, min(1.0, delay_risk_sum))
    confidence = sum(confidence_factors) / len(confidence_factors) if confidence_factors else 0.0
    confidence = max(0.0, min(1.0, confidence))

    # 关键假设与公式说明（可解释、可追溯）
    assumptions["产量公式"] = "sum(任务预期产量 × 人员速度系数)"
    assumptions["延误公式"] = "min(1, sum(max(0, 预测时长/速度 − 可用时长)/可用时长))"
    assumptions["高负荷判定"] = f"当前负荷 + 任务负荷增量 > 阈值 {load_high_threshold:.2f}"
    assumptions["低电量判定"] = (
        f"预测电量=当前电量−消耗率×剩余小时 < 阈值 {battery_low_threshold:.2f}；故障设备直接标记"
    )
    assumptions["拥堵公式"] = "sum(新占用人数 − 当前占用人数) 各方案涉及工位"
    assumptions["班次剩余小时"] = remaining_hours

    return PlanMetrics(
        estimated_output=estimated_output,
        on_time_probability=on_time_probability,
        delay_risk=delay_risk,
        high_load_persons=sorted(high_load_persons),
        total_travel_distance_m=total_travel,
        low_battery_devices=sorted(low_battery_devices),
        congestion_delta=congestion_delta,
        affected_persons=sorted(affected_persons),
        key_assumptions=assumptions,
        confidence=confidence,
    )
