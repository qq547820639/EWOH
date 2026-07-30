"""空间与上下文感知规则集（算法第一阶段：规则与统计模型）。

对应 spec「算法分阶段实施」第一阶段：规则与统计模型（可解释、易验收）。本模块在
现有 inference/rules.py 的 RuleEngine（POSTURE_BEND_LONG / LOAD_CONTINUOUS /
SENSOR_DEGRADED / DEVICE_OFFLINE）基础上，扩展空间与上下文感知规则，输出可解释
的 RuleFinding，交由 EventEngine 进一步落事件。

设计要点：
- 纯 Python 标准库实现。
- 每条规则为继承 RuleBase 的类，携带 rule_id / rule_version / severity / config，
  通过 evaluate(ctx) -> Optional[RuleFinding] 输出。
- 不直接依赖 perception 包（Task 12 在并行开发）：通过 duck-typed 接口接受 dict
  或对象（见 _get / _as_pose）。
- 状态保存在规则实例内（如 {person_id: since_ms}），跨 evaluate 调用累积；持续型
  规则在条件消失时复位，避免每帧重复触发（去重交给 EventEngine，规则内仅做最小
  状态机收口）。

ctx 字段约定（duck-typed，dict 或对象均可）：
- fused_state: 当前融合感知状态，期望字段：
    person_id(str), device_id(str), station_id(str),
    pose(Pose 或 dict{x,y,z,yaw_deg,confidence}),
    trunk_pitch_deg(float), assist_level(float), torque_nm(float),
    battery_percent(float), drain_rate_per_min(float, 可空：未提供则规则内部按历史
       电量样本估算),
    current_action(str), actions_window(list[{action, ts_ms, load_score}]),
    load_score(float), last_telemetry_ts(str),
    station_enter_ts(str), expected_dwell_sec(float),
    sensor_conflicts(list[dict|SensorConflict]：{type, uwb_station, vision_station,
       uwb_confidence, vision_confidence, ts_ms}),
    shift_start_ts(str), pose_confidence(float, 可空)
- device_state: 设备状态，期望字段：device_id, last_seen_ts(str), status(str)
- task_state: 任务状态，期望字段：task_id, person_id, assigned_ts,
    start_deadline_ts, complete_deadline_ts, started_ts(str|None),
    completed_ts(str|None), station_id(str, 可空)
- spatial_registry: edge_platform.spatial.entities.SpatialRegistry 实例，用于按
    EntityType.ZONE 查询禁区；或通过 ctx['zone_registry'] 显式传入
    （list[dict]：{zone_id, bbox: BoundingBox, status}）
- now_ts: 当前评估时间（ISO 字符串或毫秒整数）
"""

from dataclasses import dataclass
from typing import Any, Dict, Optional

from edge_platform.spatial import Pose, BoundingBox, distance, new_id, now_iso
from edge_platform.inference import ts_to_ms, ms_to_ts, new_id as inf_new_id


# ---------- 通用工具 ----------

def _get(obj, key, default=None):
    """从 dict 或对象取属性（duck-typed，避免与 perception 包耦合）。"""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _to_ms(ts):
    """ISO 字符串或毫秒整数 -> 毫秒整数；None -> None。"""
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        return int(ts)
    return ts_to_ms(ts)


def _num(v, default=None):
    """安全转 float；失败/None 返回 default。"""
    if v is None:
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _fmt(v, fmt="%.2f"):
    """格式化数值，None 显示为 '-'。"""
    if v is None:
        return "-"
    try:
        return fmt % float(v)
    except (TypeError, ValueError):
        return str(v)


def _as_pose(pose):
    """将 dict 或 Pose 规整为带 .x/.y/.confidence 的 Pose 对象。"""
    if pose is None:
        return None
    if isinstance(pose, dict):
        return Pose(
            x=pose.get("x", 0.0), y=pose.get("y", 0.0), z=pose.get("z", 0.0),
            yaw_deg=pose.get("yaw_deg", 0.0),
            source=pose.get("source", ""),
            confidence=pose.get("confidence", 1.0),
        )
    return pose


# ---------- 数据结构 ----------

@dataclass
class RuleFinding:
    """规则触发产物：可解释、可追溯，交由 EventEngine 落事件。"""
    rule_id: str
    rule_version: str
    severity: str
    person_id: Optional[str]
    device_id: Optional[str]
    station_id: Optional[str]
    message: str
    evidence: Dict[str, Any]
    triggered_at: str
    confidence: float = 1.0

    def to_dict(self):
        return {
            "rule_id": self.rule_id,
            "rule_version": self.rule_version,
            "severity": self.severity,
            "person_id": self.person_id,
            "device_id": self.device_id,
            "station_id": self.station_id,
            "message": self.message,
            "evidence": dict(self.evidence),
            "triggered_at": self.triggered_at,
            "confidence": self.confidence,
        }


class RuleBase:
    """规则基类：子类设置 rule_id / rule_version / severity / DEFAULT_CONFIG，
    实现 evaluate(ctx) -> Optional[RuleFinding]。"""

    rule_id: str = ""
    rule_version: str = "spatial-rule-v1.0"
    severity: str = "L1"
    DEFAULT_CONFIG: Dict[str, Any] = {}

    def __init__(self, config=None, rule_version=None):
        self.config = dict(self.DEFAULT_CONFIG)
        if config:
            self.config.update(config)
        if rule_version is not None:
            self.rule_version = rule_version

    def evaluate(self, ctx) -> Optional[RuleFinding]:
        raise NotImplementedError

    def _finding(self, person_id, device_id, station_id, message, evidence,
                 triggered_at, confidence=1.0):
        """构造 RuleFinding 的统一入口，附带证据引用。"""
        ev = dict(evidence)
        ev.setdefault("ref", inf_new_id("FND"))
        return RuleFinding(
            rule_id=self.rule_id,
            rule_version=self.rule_version,
            severity=self.severity,
            person_id=person_id,
            device_id=device_id,
            station_id=station_id,
            message=message,
            evidence=ev,
            triggered_at=triggered_at,
            confidence=confidence,
        )


# ---------- 1. 姿态阈值（持续） ----------

class PostureThresholdRule(RuleBase):
    """躯干前倾角持续超阈值（在现有 POSTURE_BEND_LONG 基础上扩展空间上下文）。

    配置（默认值）：
        trunk_pitch_deg: 前倾角阈值（度），默认 45.0
        sustained_sec: 持续秒数，默认 60（demo 可设 5）
    """

    rule_id = "POSTURE_THRESHOLD"
    rule_version = "spatial-rule-v1.0"
    severity = "L1"
    DEFAULT_CONFIG = {"trunk_pitch_deg": 45.0, "sustained_sec": 60}

    def __init__(self, config=None, rule_version=None):
        super().__init__(config, rule_version)
        self._since = {}  # person_id -> since_ms
        self._open = {}   # person_id -> bool（已触发未收口）

    def evaluate(self, ctx) -> Optional[RuleFinding]:
        fs = ctx.get("fused_state")
        now_ms = _to_ms(ctx.get("now_ts"))
        pitch = _num(_get(fs, "trunk_pitch_deg"))
        if pitch is None or now_ms is None:
            return None
        person_id = _get(fs, "person_id")
        threshold = self.config["trunk_pitch_deg"]
        sustained_ms = self.config["sustained_sec"] * 1000
        cond = pitch > threshold
        if cond:
            if person_id not in self._since:
                self._since[person_id] = now_ms
            if (not self._open.get(person_id)
                    and now_ms - self._since[person_id] >= sustained_ms):
                self._open[person_id] = True
                pose = _as_pose(_get(fs, "pose"))
                conf = _num(_get(pose, "confidence"), 1.0)
                return self._finding(
                    person_id=person_id,
                    device_id=_get(fs, "device_id"),
                    station_id=_get(fs, "station_id"),
                    message="躯干前倾角 %.1f° 超阈值 %.1f° 持续 ≥%ss"
                            % (pitch, threshold, self.config["sustained_sec"]),
                    evidence={
                        "trunk_pitch_deg": pitch,
                        "threshold_deg": threshold,
                        "sustained_sec": self.config["sustained_sec"],
                        "since_ts": ms_to_ts(self._since[person_id]),
                        "now_ts": ms_to_ts(now_ms),
                    },
                    triggered_at=ms_to_ts(now_ms),
                    confidence=conf,
                )
        else:
            # 条件消失 → 复位状态机（下次重新计时）
            self._since.pop(person_id, None)
            self._open.pop(person_id, None)
        return None


# ---------- 2. 高负荷持续时长 ----------

class HighLoadDurationRule(RuleBase):
    """助力水平或力矩持续超阈值（在现有 LOAD_CONTINUOUS 基础上扩展空间上下文）。

    配置（默认值）：
        load_assist: 助力水平阈值（0..1），默认 0.8
        load_torque_nm: 力矩阈值（Nm），默认 20.0
        sustained_sec: 持续秒数，默认 150（demo 可设 5）
    """

    rule_id = "HIGH_LOAD_DURATION"
    rule_version = "spatial-rule-v1.0"
    severity = "L2"
    DEFAULT_CONFIG = {"load_assist": 0.8, "load_torque_nm": 20.0, "sustained_sec": 150}

    def __init__(self, config=None, rule_version=None):
        super().__init__(config, rule_version)
        self._since = {}
        self._open = {}

    def evaluate(self, ctx) -> Optional[RuleFinding]:
        fs = ctx.get("fused_state")
        now_ms = _to_ms(ctx.get("now_ts"))
        if now_ms is None:
            return None
        assist = _num(_get(fs, "assist_level"))
        torque = _num(_get(fs, "torque_nm"))
        a_thr = self.config["load_assist"]
        t_thr = self.config["load_torque_nm"]
        cond = ((assist is not None and assist > a_thr)
                or (torque is not None and torque > t_thr))
        person_id = _get(fs, "person_id")
        sustained_ms = self.config["sustained_sec"] * 1000
        if cond:
            if person_id not in self._since:
                self._since[person_id] = now_ms
            if (not self._open.get(person_id)
                    and now_ms - self._since[person_id] >= sustained_ms):
                self._open[person_id] = True
                return self._finding(
                    person_id=person_id,
                    device_id=_get(fs, "device_id"),
                    station_id=_get(fs, "station_id"),
                    message="高负荷持续 ≥%ss（assist=%s torque=%sNm）"
                            % (self.config["sustained_sec"],
                               _fmt(assist), _fmt(torque, "%.1f")),
                    evidence={
                        "assist_level": assist,
                        "torque_nm": torque,
                        "load_assist": a_thr,
                        "load_torque_nm": t_thr,
                        "sustained_sec": self.config["sustained_sec"],
                        "since_ts": ms_to_ts(self._since[person_id]),
                        "now_ts": ms_to_ts(now_ms),
                    },
                    triggered_at=ms_to_ts(now_ms),
                )
        else:
            self._since.pop(person_id, None)
            self._open.pop(person_id, None)
        return None


# ---------- 3. 高负荷动作计数（滑窗） ----------

class ActionCountRule(RuleBase):
    """滑窗内高负荷动作（lift/carry）次数超阈值。

    配置（默认值）：
        high_load_actions: 高负荷动作集合，默认 ("lift", "carry")
        window_sec: 滑窗秒数，默认 300
        max_count: 滑窗内允许的最大次数，默认 10
    输入：fused_state.actions_window（list[{action, ts_ms, load_score}]，融合层维护）
          或 fused_state.current_action（单条，规则内部累计）。
    """

    rule_id = "ACTION_COUNT"
    rule_version = "spatial-rule-v1.0"
    severity = "L2"
    DEFAULT_CONFIG = {
        "high_load_actions": ("lift", "carry"),
        "window_sec": 300,
        "max_count": 10,
    }

    def __init__(self, config=None, rule_version=None):
        super().__init__(config, rule_version)
        self._events = {}  # person_id -> list[(ts_ms, action)]
        self._open = {}    # person_id -> bool

    def evaluate(self, ctx) -> Optional[RuleFinding]:
        fs = ctx.get("fused_state")
        now_ms = _to_ms(ctx.get("now_ts"))
        if now_ms is None:
            return None
        person_id = _get(fs, "person_id")
        high_actions = tuple(self.config["high_load_actions"])
        window_ms = self.config["window_sec"] * 1000
        max_count = self.config["max_count"]

        events = self._events.setdefault(person_id, [])
        aw = _get(fs, "actions_window")
        if isinstance(aw, list) and aw:
            # 融合层已维护窗口 → 直接覆盖本帧事件
            events = []
            for e in aw:
                if _get(e, "action") in high_actions:
                    t = _to_ms(_get(e, "ts_ms")) or now_ms
                    events.append((t, _get(e, "action")))
            self._events[person_id] = events
        else:
            cur = _get(fs, "current_action")
            if cur in high_actions:
                events.append((now_ms, cur))

        # 修剪滑窗
        cutoff = now_ms - window_ms
        events[:] = [e for e in events if e[0] >= cutoff]
        count = len(events)

        if count > max_count:
            if not self._open.get(person_id):
                self._open[person_id] = True
                return self._finding(
                    person_id=person_id,
                    device_id=_get(fs, "device_id"),
                    station_id=_get(fs, "station_id"),
                    message="近 %ss 内高负荷动作 %d 次超过上限 %d 次"
                            % (self.config["window_sec"], count, max_count),
                    evidence={
                        "window_sec": self.config["window_sec"],
                        "count": count,
                        "max_count": max_count,
                        "high_load_actions": list(high_actions),
                    },
                    triggered_at=ms_to_ts(now_ms),
                )
        else:
            self._open.pop(person_id, None)
        return None


# ---------- 4. 电量预测 ----------

class BatteryPredictionRule(RuleBase):
    """按当前放电速率预测电量抵达低阈值的时间，若在 horizon 内则告警。

    配置（默认值）：
        low_threshold: 低电量阈值（%），默认 20.0
        horizon_min: 预测窗口（分钟），默认 15
        min_drain_per_min: 触发预测的最小放电速率（%/min），默认 0.05
        sample_keep: 内部历史样本保留数，默认 20
    输入：fused_state.battery_percent、fused_state.drain_rate_per_min（可空，
          未提供则按内部历史样本估算）。
    """

    rule_id = "BATTERY_PREDICTION"
    rule_version = "spatial-rule-v1.0"
    severity = "L1"
    DEFAULT_CONFIG = {
        "low_threshold": 20.0,
        "horizon_min": 15,
        "min_drain_per_min": 0.05,
        "sample_keep": 20,
    }

    def __init__(self, config=None, rule_version=None):
        super().__init__(config, rule_version)
        self._samples = {}  # device_id -> list[(ts_ms, battery)]
        self._open = {}     # device_id -> bool

    def evaluate(self, ctx) -> Optional[RuleFinding]:
        fs = ctx.get("fused_state")
        now_ms = _to_ms(ctx.get("now_ts"))
        bat = _num(_get(fs, "battery_percent"))
        if now_ms is None or bat is None:
            return None
        device_id = _get(fs, "device_id")
        person_id = _get(fs, "person_id")
        low = self.config["low_threshold"]
        horizon = self.config["horizon_min"]
        min_drain = self.config["min_drain_per_min"]

        # 放电速率：优先使用融合层提供
        drain = _num(_get(fs, "drain_rate_per_min"))
        if drain is None:
            samples = self._samples.setdefault(device_id, [])
            samples.append((now_ms, bat))
            if len(samples) > self.config["sample_keep"]:
                samples[:] = samples[-self.config["sample_keep"]:]
            if len(samples) >= 2:
                t0, b0 = samples[0]
                t1, b1 = samples[-1]
                dt_min = (t1 - t0) / 60000.0
                if dt_min > 0 and b1 < b0:
                    drain = (b0 - b1) / dt_min
        if drain is None or drain < min_drain:
            self._open.pop(device_id, None)
            return None

        # 已低于阈值 → 不预测（由其他规则处理低电量本身）
        if bat <= low:
            self._open.pop(device_id, None)
            return None

        predicted_min = (bat - low) / drain
        if 0 < predicted_min <= horizon:
            if not self._open.get(device_id):
                self._open[device_id] = True
                return self._finding(
                    person_id=person_id,
                    device_id=device_id,
                    station_id=_get(fs, "station_id"),
                    message="预计 %.1f 分钟后电量降至 %.0f%%（当前 %.1f%%，放电 %.2f%%/min）"
                            % (predicted_min, low, bat, drain),
                    evidence={
                        "battery_percent": bat,
                        "low_threshold": low,
                        "drain_rate_per_min": drain,
                        "predicted_min_to_low": predicted_min,
                        "horizon_min": horizon,
                    },
                    triggered_at=ms_to_ts(now_ms),
                )
        else:
            self._open.pop(device_id, None)
        return None


# ---------- 5. 失联检测 ----------

class OfflineDetectionRule(RuleBase):
    """设备超过阈值秒数无遥测视为失联。

    配置（默认值）：
        offline_sec: 失联阈值秒数，默认 60
    输入：device_state.last_seen_ts（或 fused_state.last_telemetry_ts）。
    """

    rule_id = "DEVICE_OFFLINE_PREDICTION"
    rule_version = "spatial-rule-v1.0"
    severity = "L1"
    DEFAULT_CONFIG = {"offline_sec": 60}

    def __init__(self, config=None, rule_version=None):
        super().__init__(config, rule_version)
        self._open = {}  # device_id -> bool

    def evaluate(self, ctx) -> Optional[RuleFinding]:
        ds = ctx.get("device_state")
        now_ms = _to_ms(ctx.get("now_ts"))
        if now_ms is None:
            return None
        device_id = _get(ds, "device_id")
        fs = ctx.get("fused_state")
        if device_id is None:
            device_id = _get(fs, "device_id")
        last_seen = _get(ds, "last_seen_ts")
        if last_seen is None:
            last_seen = _get(fs, "last_telemetry_ts")
        if device_id is None or last_seen is None:
            return None
        last_ms = _to_ms(last_seen)
        if last_ms is None:
            return None
        gap_sec = (now_ms - last_ms) / 1000.0
        if gap_sec >= self.config["offline_sec"]:
            if not self._open.get(device_id):
                self._open[device_id] = True
                return self._finding(
                    person_id=_get(fs, "person_id"),
                    device_id=device_id,
                    station_id=_get(fs, "station_id"),
                    message="设备已失联 %.0f 秒（阈值 %s 秒）"
                            % (gap_sec, self.config["offline_sec"]),
                    evidence={
                        "last_seen_ts": ms_to_ts(last_ms),
                        "now_ts": ms_to_ts(now_ms),
                        "gap_sec": gap_sec,
                        "offline_sec": self.config["offline_sec"],
                    },
                    triggered_at=ms_to_ts(now_ms),
                )
        else:
            self._open.pop(device_id, None)
        return None


# ---------- 6. 工位停留超时 ----------

class StationDwellRule(RuleBase):
    """人员在工位停留超出预期任务时长。

    配置（默认值）：
        dwell_slack_sec: 容差秒数，默认 30
        default_expected_dwell_sec: 缺省预期停留秒数，默认 300
    输入：fused_state.station_id, station_enter_ts, expected_dwell_sec。
    """

    rule_id = "STATION_DWELL"
    rule_version = "spatial-rule-v1.0"
    severity = "L2"
    DEFAULT_CONFIG = {"dwell_slack_sec": 30, "default_expected_dwell_sec": 300}

    def __init__(self, config=None, rule_version=None):
        super().__init__(config, rule_version)
        self._open = {}  # (person_id, station_id) -> bool

    def evaluate(self, ctx) -> Optional[RuleFinding]:
        fs = ctx.get("fused_state")
        now_ms = _to_ms(ctx.get("now_ts"))
        if now_ms is None:
            return None
        station_id = _get(fs, "station_id")
        enter_ts = _get(fs, "station_enter_ts")
        if station_id is None or enter_ts is None:
            return None
        enter_ms = _to_ms(enter_ts)
        if enter_ms is None:
            return None
        person_id = _get(fs, "person_id")
        expected = _num(_get(fs, "expected_dwell_sec"),
                        self.config["default_expected_dwell_sec"])
        slack = self.config["dwell_slack_sec"]
        dwell_sec = (now_ms - enter_ms) / 1000.0
        if dwell_sec >= expected + slack:
            key = (person_id, station_id)
            if not self._open.get(key):
                self._open[key] = True
                return self._finding(
                    person_id=person_id,
                    device_id=_get(fs, "device_id"),
                    station_id=station_id,
                    message="工位 %s 停留 %.0f 秒超出预期 %.0f 秒（容差 %s 秒）"
                            % (station_id, dwell_sec, expected, slack),
                    evidence={
                        "station_id": station_id,
                        "station_enter_ts": ms_to_ts(enter_ms),
                        "dwell_sec": dwell_sec,
                        "expected_dwell_sec": expected,
                        "dwell_slack_sec": slack,
                    },
                    triggered_at=ms_to_ts(now_ms),
                )
        else:
            self._open.pop((person_id, station_id), None)
        return None


# ---------- 7. 任务超时 ----------

class TaskTimeoutRule(RuleBase):
    """分配任务未按期开工或未按期完工。

    配置（默认值）：
        start_overdue_sec: 开工 SLA 容差秒数，默认 60
    输入：task_state.{task_id, person_id, assigned_ts, start_deadline_ts,
                    complete_deadline_ts, started_ts, completed_ts, station_id}
    """

    rule_id = "TASK_TIMEOUT"
    rule_version = "spatial-rule-v1.0"
    severity = "L2"
    DEFAULT_CONFIG = {"start_overdue_sec": 60}

    def __init__(self, config=None, rule_version=None):
        super().__init__(config, rule_version)
        self._open = {}  # (task_id, kind) -> bool

    def evaluate(self, ctx) -> Optional[RuleFinding]:
        ts = ctx.get("task_state")
        now_ms = _to_ms(ctx.get("now_ts"))
        if now_ms is None or ts is None:
            return None
        task_id = _get(ts, "task_id")
        person_id = _get(ts, "person_id")
        if task_id is None:
            return None
        fs = ctx.get("fused_state")
        station_id = _get(ts, "station_id") or _get(fs, "station_id")
        device_id = _get(fs, "device_id")
        started = _get(ts, "started_ts")
        completed = _get(ts, "completed_ts")

        # 未按期开工
        start_dl = _get(ts, "start_deadline_ts")
        if start_dl and not started:
            start_dl_ms = _to_ms(start_dl)
            if start_dl_ms is not None:
                gap = (now_ms - start_dl_ms) / 1000.0
                if gap >= self.config["start_overdue_sec"]:
                    key = (task_id, "start")
                    if not self._open.get(key):
                        self._open[key] = True
                        return self._finding(
                            person_id=person_id,
                            device_id=device_id,
                            station_id=station_id,
                            message="任务 %s 未按期开工（超期 %.0f 秒）" % (task_id, gap),
                            evidence={
                                "task_id": task_id,
                                "kind": "start_overdue",
                                "start_deadline_ts": ms_to_ts(start_dl_ms),
                                "now_ts": ms_to_ts(now_ms),
                                "gap_sec": gap,
                            },
                            triggered_at=ms_to_ts(now_ms),
                        )
        else:
            self._open.pop((task_id, "start"), None)

        # 未按期完工
        if started and not completed:
            comp_dl = _get(ts, "complete_deadline_ts")
            if comp_dl:
                comp_dl_ms = _to_ms(comp_dl)
                if comp_dl_ms is not None:
                    gap = (now_ms - comp_dl_ms) / 1000.0
                    if gap >= 0:
                        key = (task_id, "complete")
                        if not self._open.get(key):
                            self._open[key] = True
                            return self._finding(
                                person_id=person_id,
                                device_id=device_id,
                                station_id=station_id,
                                message="任务 %s 未按期完工（超期 %.0f 秒）" % (task_id, gap),
                                evidence={
                                    "task_id": task_id,
                                    "kind": "complete_overdue",
                                    "started_ts": started,
                                    "complete_deadline_ts": ms_to_ts(comp_dl_ms),
                                    "now_ts": ms_to_ts(now_ms),
                                    "gap_sec": gap,
                                },
                                triggered_at=ms_to_ts(now_ms),
                            )
        else:
            self._open.pop((task_id, "complete"), None)

        return None


# ---------- 8. 禁区闯入 ----------

class ZoneViolationRule(RuleBase):
    """人员进入禁区/受限区（基于 BoundingBox.contains + 人员 pose）。

    配置（默认值）：
        forbidden_statuses: 视为禁区的 zone 状态集合，默认 ("forbidden", "restricted")
    输入：
        fused_state.pose（Pose 或 dict，含 x/y）
        ctx["zone_registry"]（显式 list[dict]：{zone_id, bbox: BoundingBox, status}）
        或 ctx["spatial_registry"]（SpatialRegistry：按 EntityType.ZONE 查询，
          zone.status 在 forbidden_statuses 中即视为禁区，bbox 为其边界框）
    """

    rule_id = "ZONE_VIOLATION"
    rule_version = "spatial-rule-v1.0"
    severity = "L1"
    DEFAULT_CONFIG = {
        "forbidden_statuses": ("forbidden", "restricted"),
    }

    def __init__(self, config=None, rule_version=None):
        super().__init__(config, rule_version)
        self._open = {}  # (person_id, zone_id) -> bool

    def _iter_zones(self, ctx):
        zones = ctx.get("zone_registry")
        if isinstance(zones, list):
            for z in zones:
                yield z
            return
        sr = ctx.get("spatial_registry")
        if sr is None:
            return
        # 鸭子类型：优先 by_type("ZONE")，失败则 all() 过滤
        try:
            ents = sr.by_type("ZONE")
        except Exception:
            ents = sr.all() if hasattr(sr, "all") else []
        for e in ents:
            yield e

    def evaluate(self, ctx) -> Optional[RuleFinding]:
        fs = ctx.get("fused_state")
        now_ms = _to_ms(ctx.get("now_ts"))
        if now_ms is None:
            return None
        pose = _as_pose(_get(fs, "pose"))
        if pose is None:
            return None
        person_id = _get(fs, "person_id")
        forbidden = tuple(self.config["forbidden_statuses"])

        for z in self._iter_zones(ctx):
            zone_id = _get(z, "zone_id") or _get(z, "entity_id")
            bbox = _get(z, "bbox")
            label = _get(z, "status") or _get(z, "label")
            if zone_id is None or bbox is None:
                continue
            if label not in forbidden:
                continue
            inside = bbox.contains(pose) if hasattr(bbox, "contains") else False
            key = (person_id, zone_id)
            if inside:
                if not self._open.get(key):
                    self._open[key] = True
                    return self._finding(
                        person_id=person_id,
                        device_id=_get(fs, "device_id"),
                        station_id=_get(fs, "station_id"),
                        message="人员进入禁区 %s（%s）" % (zone_id, label),
                        evidence={
                            "zone_id": zone_id,
                            "zone_label": label,
                            "pose": pose.to_dict() if hasattr(pose, "to_dict") else pose,
                            "bbox": bbox.to_dict() if hasattr(bbox, "to_dict") else bbox,
                        },
                        triggered_at=ms_to_ts(now_ms),
                        confidence=_num(_get(pose, "confidence"), 1.0),
                    )
            else:
                # 离开禁区 → 复位，允许下次进入再次触发
                self._open.pop(key, None)
        return None


# ---------- 9. 传感器冲突（包装感知层事件） ----------

class SensorConflictRule(RuleBase):
    """将感知融合层的传感器冲突包装为 RuleFinding（不丢弃，可解释）。

    配置（默认值）：
        max_per_call: 单次 evaluate 最多输出冲突数，默认 1（其余由后续调用或
          EventEngine 处理）
    输入：fused_state.sensor_conflicts：list[dict|SensorConflict]，每项期望字段：
          type, uwb_station, vision_station, uwb_confidence, vision_confidence, ts_ms
    """

    rule_id = "SENSOR_CONFLICT"
    rule_version = "spatial-rule-v1.0"
    severity = "L1"
    DEFAULT_CONFIG = {"max_per_call": 1}

    def evaluate(self, ctx) -> Optional[RuleFinding]:
        fs = ctx.get("fused_state")
        now_ms = _to_ms(ctx.get("now_ts"))
        if now_ms is None:
            return None
        conflicts = _get(fs, "sensor_conflicts")
        if not conflicts or not isinstance(conflicts, list):
            return None
        person_id = _get(fs, "person_id")
        for c in conflicts[: self.config["max_per_call"]]:
            ctype = _get(c, "type", "unknown")
            uwb_st = _get(c, "uwb_station")
            vis_st = _get(c, "vision_station")
            uwb_conf = _num(_get(c, "uwb_confidence"), 0.0)
            vis_conf = _num(_get(c, "vision_confidence"), 0.0)
            c_ts = _to_ms(_get(c, "ts_ms")) or now_ms
            conf = min(uwb_conf, vis_conf) if (uwb_conf and vis_conf) else 0.5
            return self._finding(
                person_id=person_id,
                device_id=_get(fs, "device_id"),
                station_id=uwb_st or vis_st,
                message="传感器冲突：%s（UWB 工位 %s vs 视觉工位 %s）"
                        % (ctype, uwb_st, vis_st),
                evidence={
                    "conflict_type": ctype,
                    "uwb_station": uwb_st,
                    "vision_station": vis_st,
                    "uwb_confidence": uwb_conf,
                    "vision_confidence": vis_conf,
                    "conflict_ts": ms_to_ts(c_ts),
                },
                triggered_at=ms_to_ts(now_ms),
                confidence=conf,
            )
        return None


# ---------- 10. 累计负荷积分 ----------

class CumulativeLoadIntegralRule(RuleBase):
    """班次内累计负荷积分（load_score × dt 的简单累加）超阈值告警。

    配置（默认值）：
        threshold: 累计负荷阈值，默认 100.0
        shift_timeout_sec: 班次空闲超时复位秒数，默认 3600
    输入：fused_state.load_score、fused_state.shift_start_ts。
    状态：每人员维护 (last_ms, accumulator)；shift_start 变化时复位。
    """

    rule_id = "CUMULATIVE_LOAD_INTEGRAL"
    rule_version = "spatial-rule-v1.0"
    severity = "L2"
    DEFAULT_CONFIG = {"threshold": 100.0, "shift_timeout_sec": 3600}

    def __init__(self, config=None, rule_version=None):
        super().__init__(config, rule_version)
        self._acc = {}   # person_id -> {"shift_start", "last_ms", "value"}
        self._open = {}  # person_id -> bool

    def reset(self, person_id=None):
        """复位累计器（班次结束/换班时调用）。"""
        if person_id is None:
            self._acc.clear()
            self._open.clear()
        else:
            self._acc.pop(person_id, None)
            self._open.pop(person_id, None)

    def evaluate(self, ctx) -> Optional[RuleFinding]:
        fs = ctx.get("fused_state")
        now_ms = _to_ms(ctx.get("now_ts"))
        load = _num(_get(fs, "load_score"), 0.0)
        if now_ms is None:
            return None
        person_id = _get(fs, "person_id")
        shift_start = _get(fs, "shift_start_ts")
        threshold = self.config["threshold"]
        shift_timeout_ms = self.config["shift_timeout_sec"] * 1000

        st = self._acc.get(person_id)
        if st is None or (shift_start and st.get("shift_start") != shift_start):
            st = {"shift_start": shift_start, "last_ms": now_ms, "value": 0.0}
            self._acc[person_id] = st
        # 班次长时间空闲 → 复位（避免跨班次累加）
        if now_ms - st["last_ms"] >= shift_timeout_ms:
            st["value"] = 0.0
        dt_sec = max(0.0, (now_ms - st["last_ms"]) / 1000.0)
        st["value"] += max(0.0, load) * dt_sec
        st["last_ms"] = now_ms

        if st["value"] >= threshold:
            if not self._open.get(person_id):
                self._open[person_id] = True
                return self._finding(
                    person_id=person_id,
                    device_id=_get(fs, "device_id"),
                    station_id=_get(fs, "station_id"),
                    message="累计负荷积分 %.1f 超阈值 %.1f"
                            % (st["value"], threshold),
                    evidence={
                        "cumulative_load": st["value"],
                        "threshold": threshold,
                        "shift_start_ts": shift_start,
                        "now_ts": ms_to_ts(now_ms),
                        "current_load_score": load,
                    },
                    triggered_at=ms_to_ts(now_ms),
                )
        return None
