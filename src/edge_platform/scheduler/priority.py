"""有效优先级计算：多因素加权，产出可审计的有效优先级。

联合调度中，任务优先级不应只看 base 一个数字，而应综合：
- base：基础优先级（任务自身 priority）；
- deadline_pressure：截止时间紧迫度（剩余时间越短压力越大）；
- downstream_blocking：下游阻塞量（延误会波及的后继任务数）；
- safety_urgency：安全关键加权；
- aging_bonus：等待老化加成（防止饥饿，等待越久加成越高）。

每个分量均可配置权重，且计算过程中把所用权重与中间量记录进返回 dict，
保证"组件可审计"（spec：权重可配置、每次调整入审计、不得由算法隐藏决定）。

纯 Python 标准库实现；用 datetime 解析 now 与任务时间字段。
"""

from datetime import datetime, timezone


def _parse_ts(ts, default=None):
    """解析 ISO 8601 时间字符串为 aware datetime；非法/空返回 default。"""
    if not ts:
        return default
    s = str(ts).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except (TypeError, ValueError):
        return default
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


class EffectivePriorityCalculator:
    """有效优先级计算器。

    weights 可选键（均缺省为 0，便于只启用部分因素）：
    - base:       base 权重（作用于 task.priority）
    - deadline:   deadline 权重（作用于 deadline_pressure）
    - downstream: 下游阻塞权重（作用于 downstream_blocking）
    - safety:     安全关键权重（作用于 safety_urgency）
    - aging:      老化加成权重（作用于 aging_bonus）
    - horizon_sec: 紧迫度/老化归一化时间窗（缺省 3600 秒）
    """

    def __init__(self, weights: dict = None):
        weights = weights or {}
        self.weights = {
            "base": float(weights.get("base", 1.0) or 0.0),
            "deadline": float(weights.get("deadline", 1.0) or 0.0),
            "downstream": float(weights.get("downstream", 1.0) or 0.0),
            "safety": float(weights.get("safety", 1.0) or 0.0),
            "aging": float(weights.get("aging", 0.5) or 0.0),
            "horizon_sec": float(weights.get("horizon_sec", 3600.0) or 3600.0),
        }

    def compute(self, task, now_iso_str=None):
        """计算任务的有效优先级。

        task 为 dict（键均可缺省）：priority / due_at / earliest_start / release_at /
        created_at / safety_critical / downstream_task_ids。
        返回 dict 含 effective_priority 及各分量、所用权重（可审计）。
        """
        task = task or {}
        now = _parse_ts(now_iso_str) or datetime.now(timezone.utc)
        w = self.weights
        horizon = max(float(w["horizon_sec"]), 1e-9)

        # 1) base：基础优先级（0..10 归一化到 0..1）
        raw_priority = float(task.get("priority", 0) or 0)
        base = w["base"] * _clamp(raw_priority / 10.0)

        # 2) deadline_pressure：剩余时间越短压力越大
        due = _parse_ts(task.get("due_at"))
        deadline_pressure = 0.0
        if due is not None:
            remaining = (due - now).total_seconds()
            if remaining <= 0:
                deadline_pressure = 1.0  # 已过期 → 最大压力
            else:
                deadline_pressure = _clamp(1.0 - remaining / horizon)
            deadline_pressure = w["deadline"] * deadline_pressure

        # 3) downstream_blocking：后继任务越多，延期代价越大
        downstream = task.get("downstream_task_ids") or []
        downstream_blocking = w["downstream"] * _clamp(len(downstream) / 10.0)

        # 4) safety_urgency：安全关键作业加权
        safety_urgency = w["safety"] * (1.0 if task.get("safety_critical") else 0.0)

        # 5) aging_bonus：等待越久加成越高（防饥饿）
        ref = _parse_ts(task.get("earliest_start")) or _parse_ts(task.get("release_at"))
        if ref is None:
            ref = _parse_ts(task.get("created_at"))
        aging_bonus = 0.0
        if ref is not None:
            elapsed = (now - ref).total_seconds()
            aging_bonus = w["aging"] * _clamp(elapsed / horizon)

        effective = base + deadline_pressure + downstream_blocking + safety_urgency + aging_bonus

        return {
            "effective_priority": effective,
            "base": base,
            "deadline_pressure": deadline_pressure,
            "downstream_blocking": downstream_blocking,
            "safety_urgency": safety_urgency,
            "aging_bonus": aging_bonus,
            # 可审计：记录任务输入与所用权重
            "task_id": task.get("task_id", ""),
            "raw_priority": raw_priority,
            "weights_used": dict(w),
        }
