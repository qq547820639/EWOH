"""多目标评分：J = w1*产量 + w2*准时率 − w3*安全风险 − w4*人体负荷 − w5*移动距离 − w6*换岗成本。

对应 spec「决策与调度层」与「权重可审计」场景：权重可由工厂配置，每次调整入审计日志，
权重不得由算法自行隐藏决定。

分量公式（简单可解释，文档化；均取自 ctx 真实值，不虚构）：
- production_score  = ctx.expected_production_uplift（预期产量提升，标准化 0..1）
- on_time_score     = ctx.on_time_probability（准时完成概率 0..1）
- safety_risk       = ctx.safety_risk，否则由 recent_risk_events 数量推导 min(1.0, 0.2*count)
- body_load         = ctx.current_load（当前累计负荷评分 0..1）
- travel_distance   = ctx.distance_to_station，否则由 person_pose/station_pose 经
                      edge_platform.spatial.distance() 计算（米）
- changeover_cost   = 1.0 若 ctx.is_changeover 否则 0.0

travel_distance 复用 edge_platform.spatial.distance；body_load 取自累计负荷评分。

纯 Python 标准库实现。
"""

from dataclasses import dataclass, asdict

from edge_platform.spatial import now_iso, distance


@dataclass
class ScoringWeights:
    """多目标权重。默认值对应 spec 目标函数各项系数（正为收益，负为成本）。"""
    w1_production: float = 1.0
    w2_on_time: float = 1.0
    w3_safety_risk: float = 1.0
    w4_body_load: float = 1.0
    w5_travel_distance: float = 0.05
    w6_changeover_cost: float = 0.5

    def to_dict(self):
        return asdict(self)

    @classmethod
    def from_dict(cls, d):
        keys = (
            "w1_production", "w2_on_time", "w3_safety_risk",
            "w4_body_load", "w5_travel_distance", "w6_changeover_cost",
        )
        return cls(**{k: d[k] for k in keys if k in d})


@dataclass
class WeightAuditEntry:
    """权重调整审计记录：调整前 / 调整后 / 操作人 / 原因 / 时间。"""
    weights_before: dict
    weights_after: dict
    actor_id: str
    reason: str
    ts: str

    def to_dict(self):
        return asdict(self)


class WeightAuditLog:
    """权重调整审计日志（append-only）。

    spec："权重不得由算法自行隐藏决定，应允许工厂配置，并记录每次调整"。
    """

    def __init__(self):
        self._entries = []

    def record(self, weights_before, weights_after, actor_id, reason, ts=None):
        """记录一次权重调整：前后值、操作人、原因、时间。"""
        entry = WeightAuditEntry(
            weights_before=dict(weights_before),
            weights_after=dict(weights_after),
            actor_id=actor_id,
            reason=reason,
            ts=ts or now_iso(),
        )
        self._entries.append(entry)
        return entry

    def history(self):
        """返回全部调整记录（按时间顺序）。"""
        return list(self._entries)


class Scorer:
    """多目标评分器。score(candidate, ctx) 返回 (total_score, breakdown)。"""

    def __init__(self, weights, audit_log):
        self.weights = weights
        self.audit_log = audit_log

    # ---- 分量解析（从 ctx 取真实值） ----

    def _resolve_travel_distance(self, ctx):
        # 优先使用预计算距离；否则由 person_pose / station_pose 经 spatial.distance() 计算
        if ctx.get("distance_to_station") is not None:
            return float(ctx.get("distance_to_station") or 0.0)
        person_pose = ctx.get("person_pose")
        station_pose = ctx.get("station_pose")
        if person_pose is not None and station_pose is not None:
            return float(distance(person_pose, station_pose))
        return 0.0

    def _resolve_safety_risk(self, ctx):
        if ctx.get("safety_risk") is not None:
            return float(ctx.get("safety_risk") or 0.0)
        events = ctx.get("recent_risk_events") or []
        # 近期风险事件数 * 0.2，上限 1.0
        return min(1.0, 0.2 * float(len(events)))

    # ---- 评分 ----

    def score(self, candidate, ctx):
        """计算候选综合评分与分项明细。

        返回 (total_score, breakdown)；breakdown 包含各分量原值、加权贡献与合计，
        各加权贡献之和等于 total_score（供测试校验"breakdown sums to total"）。
        """
        ctx = ctx or {}
        w = self.weights

        production_score = float(ctx.get("expected_production_uplift", 0.0) or 0.0)
        on_time_score = float(ctx.get("on_time_probability", 0.0) or 0.0)
        safety_risk = self._resolve_safety_risk(ctx)
        body_load = float(ctx.get("current_load", 0.0) or 0.0)
        travel_distance = self._resolve_travel_distance(ctx)
        changeover_cost = 1.0 if ctx.get("is_changeover") else 0.0

        c1 = w.w1_production * production_score
        c2 = w.w2_on_time * on_time_score
        c3 = -w.w3_safety_risk * safety_risk
        c4 = -w.w4_body_load * body_load
        c5 = -w.w5_travel_distance * travel_distance
        c6 = -w.w6_changeover_cost * changeover_cost
        total = c1 + c2 + c3 + c4 + c5 + c6

        breakdown = {
            "production_score": production_score,
            "on_time_score": on_time_score,
            "safety_risk": safety_risk,
            "body_load": body_load,
            "travel_distance": travel_distance,
            "changeover_cost": changeover_cost,
            "w1_production_contrib": c1,
            "w2_on_time_contrib": c2,
            "w3_safety_contrib": c3,
            "w4_body_load_contrib": c4,
            "w5_travel_contrib": c5,
            "w6_changeover_contrib": c6,
            "total": total,
        }
        return total, breakdown

    def set_weights(self, new_weights, actor_id, reason):
        """更新权重并记录审计（spec：权重调整必须记录前后值/操作人/原因/时间）。

        返回新增的审计条目。
        """
        before = self.weights.to_dict()
        self.weights = new_weights
        after = self.weights.to_dict()
        self.audit_log.record(before, after, actor_id, reason)
        return self.audit_log.history()[-1]
