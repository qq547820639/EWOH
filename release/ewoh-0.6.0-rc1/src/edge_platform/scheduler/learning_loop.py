"""学习闭环（能学习）：执行结果回流 → 偏差统计 → 参数校准建议。

对应 spec Task 31「学习闭环（能学习）」与 checklist 验收：
- "建议采纳率达到 30% 以上"
  （adoption_rate = adopted_count / proposed_count >= 0.30）；
- "被采纳建议中生产或负荷指标至少一项改善"
  （improvement_rate_of_adopted = adopted_with_improvement / adopted_count > 0；
   单条改善判定：actual.production >= predicted.production
   或 actual.body_load <= predicted.body_load）。

安全约束（不可变）：
- 学习闭环只生成"建议校准"（CalibrationSuggestion），不自动修改 Scheduler 的权重或规则；
- 所有 CalibrationSuggestion 标注 applied=False，需人工确认后方可生效；
- 权重变更必须走 scoring.WeightAuditLog 正式流程（记录前后值/操作人/原因/时间），
  本模块不直接调用 Scorer.set_weights，仅产出建议供人工审议。

数据来源：Scheduler.feedback(request_id, actual_outcome) 已记录执行结果回流；
本模块据此聚合跨请求统计、评估采纳率与指标改善、产出参数校准建议。

纯 Python 标准库实现。
"""

from dataclasses import dataclass

from edge_platform.inference import ts_to_ms
from edge_platform.spatial import now_iso

from .orchestrator import (
    CONFIRMED,
    EXECUTED,
    REJECTED,
    SHADOW,
)

# 关键指标键名（统一 predicted / actual 字典）
_METRIC_PRODUCTION = "production"
_METRIC_BODY_LOAD = "body_load"

# 采纳阈值（spec："建议采纳率达到 30% 以上"）
_ADOPTION_RATE_TARGET = 0.30


# ---- 指标规范化工具 ----


def _normalize_metrics(raw):
    """规范化指标字典：统一 production / body_load 等键名，仅保留可数值化项。

    兼容多种来源键名：
    - production: production / actual_production / production_score
    - body_load:  body_load / actual_body_load / current_load
    其余附加指标（on_time / safety_risk 等）若存在则原样保留，便于偏差聚合。
    """
    raw = raw or {}
    out = {}
    for canonical, aliases in (
        (_METRIC_PRODUCTION, ("production", "actual_production", "production_score")),
        (_METRIC_BODY_LOAD, ("body_load", "actual_body_load", "current_load")),
    ):
        for key in aliases:
            if key in raw and raw[key] is not None:
                try:
                    out[canonical] = float(raw[key])
                except (TypeError, ValueError):
                    continue
                break
    # 附加指标原样保留（便于 delta 聚合，不强制 float）
    for k in ("on_time", "on_time_probability", "on_time_score", "safety_risk", "travel_distance"):
        if k in raw and raw[k] is not None:
            out.setdefault(k, raw[k])
    return out


def _predicted_metrics_from_candidate(cand):
    """从候选的 score_breakdown 提取预测指标。"""
    if cand is None:
        return {}
    bd = getattr(cand, "score_breakdown", None) or {}
    return _normalize_metrics(
        {
            "production": bd.get("production_score"),
            "body_load": bd.get("body_load"),
            "on_time": bd.get("on_time_score"),
            "safety_risk": bd.get("safety_risk"),
        }
    )


def _actual_metrics_from_feedback(feedback_records):
    """合并 feedback_records 中的 actual_outcome，提取实际指标（后者覆盖前者）。"""
    if not feedback_records:
        return {}
    merged = {}
    for rec in feedback_records:
        outcome = (rec.get("actual_outcome") if isinstance(rec, dict) else None) or {}
        if isinstance(outcome, dict):
            merged.update(outcome)
    return _normalize_metrics(merged)


def _metric_deltas(actual, predicted):
    """计算 actual - predicted 的差值（仅对双方均存在的键）。"""
    deltas = {}
    for k in set(actual) & set(predicted):
        try:
            deltas[k] = float(actual[k]) - float(predicted[k])
        except (TypeError, ValueError):
            continue
    return deltas


def _judge_improved(actual, predicted):
    """判断是否至少一项关键指标改善：
    - 产量提升：actual.production >= predicted.production；或
    - 负荷降低：actual.body_load <= predicted.body_load。
    无法判定（缺关键指标）时返回 None。
    """
    has_production = _METRIC_PRODUCTION in actual and _METRIC_PRODUCTION in predicted
    has_body_load = _METRIC_BODY_LOAD in actual and _METRIC_BODY_LOAD in predicted
    if not (has_production or has_body_load):
        return None
    improved = False
    if has_production and actual[_METRIC_PRODUCTION] >= predicted[_METRIC_PRODUCTION]:
        improved = True
    if not improved and has_body_load and actual[_METRIC_BODY_LOAD] <= predicted[_METRIC_BODY_LOAD]:
        improved = True
    return improved


# ---- 数据类 ----


@dataclass
class ScheduleOutcome:
    """单次调度请求的学习记录：预测/实际指标、偏差、是否改善、是否被采纳。"""

    request_id: str
    plan_id: str
    proposed_at: str
    status: str
    was_adopted: bool
    was_rejected: bool
    predicted_metrics: dict
    actual_metrics: dict
    metric_deltas: dict = None
    improved: bool = None
    ts: str = None

    def __post_init__(self):
        if self.ts is None:
            self.ts = now_iso()
        if self.metric_deltas is None:
            self.metric_deltas = {}

    @property
    def proposed_at_ms(self):
        """提议时间戳（毫秒），便于周期过滤（复用 inference.ts_to_ms）。"""
        return ts_to_ms(self.proposed_at) if self.proposed_at else None

    def to_dict(self):
        return {
            "request_id": self.request_id,
            "plan_id": self.plan_id,
            "proposed_at": self.proposed_at,
            "status": self.status,
            "was_adopted": self.was_adopted,
            "was_rejected": self.was_rejected,
            "predicted_metrics": dict(self.predicted_metrics),
            "actual_metrics": dict(self.actual_metrics),
            "metric_deltas": dict(self.metric_deltas),
            "improved": self.improved,
            "ts": self.ts,
        }


@dataclass
class LearningStats:
    """跨请求学习统计：采纳率、改善率、平均偏差，附达标判定。"""

    total_requests: int
    proposed_count: int
    adopted_count: int
    rejected_count: int
    adoption_rate: float
    adopted_with_improvement: int
    improvement_rate_of_adopted: float
    meets_target: bool
    avg_metric_deltas: dict
    period_start: str
    period_end: str

    def to_dict(self):
        return {
            "total_requests": self.total_requests,
            "proposed_count": self.proposed_count,
            "adopted_count": self.adopted_count,
            "rejected_count": self.rejected_count,
            "adoption_rate": self.adoption_rate,
            "adopted_with_improvement": self.adopted_with_improvement,
            "improvement_rate_of_adopted": self.improvement_rate_of_adopted,
            "meets_target": self.meets_target,
            "avg_metric_deltas": dict(self.avg_metric_deltas),
            "period_start": self.period_start,
            "period_end": self.period_end,
        }


@dataclass
class CalibrationSuggestion:
    """参数校准建议（只建议不自动应用，需人工确认后走 WeightAuditLog 生效）。"""

    parameter: str
    current_value: float
    suggested_value: float
    reason: str
    evidence: dict
    confidence: float
    applied: bool = False

    def to_dict(self):
        return {
            "parameter": self.parameter,
            "current_value": self.current_value,
            "suggested_value": self.suggested_value,
            "reason": self.reason,
            "evidence": dict(self.evidence),
            "confidence": self.confidence,
            "applied": self.applied,
        }


# ---- 学习闭环 ----


class LearningLoop:
    """学习闭环：聚合调度结果回流、评估采纳率与指标改善、产出参数校准建议。

    安全不变量：本类只生成"建议校准"，绝不自动修改 Scheduler 的权重或规则；
    权重变更必须由人工确认后经 scoring.WeightAuditLog 正式流程生效。
    """

    def __init__(self, scheduler):
        self.scheduler = scheduler
        self._outcomes_map = {}

    # ---- 属性 ----

    @property
    def _outcomes(self):
        """所有已记录的 ScheduleOutcome（按记录顺序）。"""
        return list(self._outcomes_map.values())

    # ---- 内部工具 ----

    @staticmethod
    def _find_candidate(req, plan_id):
        if not plan_id:
            return None
        for cand in req.candidates or []:
            if getattr(cand, "candidate_id", None) == plan_id:
                return cand
        return None

    @staticmethod
    def _in_period(ts, start_ms, end_ms):
        if not ts:
            return False
        try:
            ms = ts_to_ms(ts)
        except (TypeError, ValueError):
            return False
        if start_ms is not None and ms < start_ms:
            return False
        if end_ms is not None and ms > end_ms:
            return False
        return True

    @staticmethod
    def _avg_metric_deltas(outcomes):
        """聚合各指标的平均偏差（actual - predicted）。"""
        sums = {}
        counts = {}
        for o in outcomes:
            for k, v in (o.metric_deltas or {}).items():
                try:
                    fv = float(v)
                except (TypeError, ValueError):
                    continue
                sums[k] = sums.get(k, 0.0) + fv
                counts[k] = counts.get(k, 0) + 1
        return {k: sums[k] / counts[k] for k in sums if counts[k]}

    # ---- 主流程 ----

    def record_outcome(self, request_id):
        """记录单次调度请求的学习结果：从 feedback 提取实际指标、对比候选预测、判定改善。

        返回 ScheduleOutcome；重复记录同一 request_id 时覆盖更新。
        """
        req = self.scheduler.get_request(request_id)

        confirmed_plan_id = req.confirmed_plan_id
        cand = self._find_candidate(req, confirmed_plan_id)
        predicted = _predicted_metrics_from_candidate(cand)
        actual = _actual_metrics_from_feedback(req.feedback_records)
        deltas = _metric_deltas(actual, predicted)
        improved = _judge_improved(actual, predicted)

        was_adopted = req.status in (CONFIRMED, EXECUTED)
        was_rejected = req.status == REJECTED

        outcome = ScheduleOutcome(
            request_id=request_id,
            plan_id=confirmed_plan_id or "",
            proposed_at=req.ts,
            status=req.status,
            was_adopted=was_adopted,
            was_rejected=was_rejected,
            predicted_metrics=predicted,
            actual_metrics=actual,
            metric_deltas=deltas,
            improved=improved,
        )
        self._outcomes_map[request_id] = outcome
        return outcome

    def compute_stats(self, period_start=None, period_end=None):
        """聚合已记录 outcomes 计算学习统计与达标判定。

        period 过滤基于 outcome.proposed_at；未传则覆盖全部，并取实际数据跨度。
        验收：adoption_rate >= 0.30 且 improvement_rate_of_adopted > 0。
        """
        outcomes = self._outcomes
        start_ms = ts_to_ms(period_start) if period_start else None
        end_ms = ts_to_ms(period_end) if period_end else None
        if start_ms is not None or end_ms is not None:
            filtered = [o for o in outcomes if self._in_period(o.proposed_at, start_ms, end_ms)]
        else:
            filtered = list(outcomes)

        total = len(filtered)
        # 进入 PROPOSED 阶段的请求数：非 SHADOW（含 PROPOSED/CONFIRMED/EXECUTED/REJECTED）
        proposed_count = sum(1 for o in filtered if o.status != SHADOW)
        adopted = [o for o in filtered if o.was_adopted]
        adopted_count = len(adopted)
        rejected_count = sum(1 for o in filtered if o.was_rejected)
        adoption_rate = (adopted_count / proposed_count) if proposed_count else 0.0
        adopted_with_improvement = sum(1 for o in adopted if o.improved is True)
        improvement_rate = (adopted_with_improvement / adopted_count) if adopted_count else 0.0
        meets_target = adoption_rate >= _ADOPTION_RATE_TARGET and improvement_rate > 0.0
        avg_deltas = self._avg_metric_deltas(filtered)

        # 周期边界：传入优先，否则用数据实际跨度
        if filtered:
            times = [o.proposed_at for o in filtered if o.proposed_at]
            p_start = period_start or (min(times) if times else None)
            p_end = period_end or (max(times) if times else None)
        else:
            p_start = period_start
            p_end = period_end

        return LearningStats(
            total_requests=total,
            proposed_count=proposed_count,
            adopted_count=adopted_count,
            rejected_count=rejected_count,
            adoption_rate=adoption_rate,
            adopted_with_improvement=adopted_with_improvement,
            improvement_rate_of_adopted=improvement_rate,
            meets_target=meets_target,
            avg_metric_deltas=avg_deltas,
            period_start=p_start,
            period_end=p_end,
        )

    def _calibrations_from_stats(self, stats):
        """基于统计的平均偏差产出参数校准建议（applied=False，需人工确认）。

        - 实际产量持续低于预测（avg delta < 0）→ 建议降低 w1_production；
        - 实际负荷持续高于预测（avg delta > 0）→ 建议提升 w4_body_load。
        本方法仅产出建议，不调用 Scorer.set_weights，不修改任何权重。
        """
        avg = stats.avg_metric_deltas
        suggestions = []

        scorer = getattr(self.scheduler, "scorer", None)
        weights = getattr(scorer, "weights", None) if scorer else None
        if weights is None:
            return suggestions

        sample_count = stats.adopted_count  # 偏差样本主要来自被采纳且有 feedback 的请求
        confidence = round(min(1.0, sample_count / 10.0), 4)

        # 产量持续低于预测 → 降低产量权重
        if _METRIC_PRODUCTION in avg and avg[_METRIC_PRODUCTION] < 0:
            cur = float(weights.w1_production)
            suggested = max(0.0, round(cur - 0.1, 6))
            suggestions.append(
                CalibrationSuggestion(
                    parameter="w1_production",
                    current_value=cur,
                    suggested_value=suggested,
                    reason=(
                        f"实际产量持续低于预测（平均偏差 {avg[_METRIC_PRODUCTION]:.4f}），建议降低产量权重避免高估产能"
                    ),
                    evidence={
                        "metric": _METRIC_PRODUCTION,
                        "avg_delta": avg[_METRIC_PRODUCTION],
                        "sample_count": sample_count,
                    },
                    confidence=confidence,
                    applied=False,
                )
            )

        # 负荷持续高于预测 → 提升负荷权重
        if _METRIC_BODY_LOAD in avg and avg[_METRIC_BODY_LOAD] > 0:
            cur = float(weights.w4_body_load)
            suggested = round(cur + 0.1, 6)
            suggestions.append(
                CalibrationSuggestion(
                    parameter="w4_body_load",
                    current_value=cur,
                    suggested_value=suggested,
                    reason=(
                        f"实际负荷持续高于预测（平均偏差 {avg[_METRIC_BODY_LOAD]:.4f}），建议提升负荷权重以更谨慎排程"
                    ),
                    evidence={
                        "metric": _METRIC_BODY_LOAD,
                        "avg_delta": avg[_METRIC_BODY_LOAD],
                        "sample_count": sample_count,
                    },
                    confidence=confidence,
                    applied=False,
                )
            )

        return suggestions

    def suggest_calibrations(self):
        """基于 avg_metric_deltas 产出参数校准建议（applied=False，需人工确认）。

        安全约束：仅生成建议，不自动修改 Scheduler 权重；权重变更走 WeightAuditLog。
        """
        return self._calibrations_from_stats(self.compute_stats())

    def export_period_report(self, period_start, period_end):
        """导出周期学习报告（dict）：stats + calibrations + top_deviation_cases。"""
        stats = self.compute_stats(period_start=period_start, period_end=period_end)
        calibrations = self._calibrations_from_stats(stats)

        # 周期内偏差最大的用例（按最大单指标 |delta| 排序，取前 5）
        start_ms = ts_to_ms(period_start) if period_start else None
        end_ms = ts_to_ms(period_end) if period_end else None
        in_period = [o for o in self._outcomes if self._in_period(o.proposed_at, start_ms, end_ms)]

        def _max_dev(o):
            if not o.metric_deltas:
                return 0.0
            return max((abs(float(v)) for v in o.metric_deltas.values()), default=0.0)

        top = sorted(in_period, key=_max_dev, reverse=True)[:5]

        return {
            "period_start": stats.period_start,
            "period_end": stats.period_end,
            "stats": stats.to_dict(),
            "calibrations": [c.to_dict() for c in calibrations],
            "top_deviation_cases": [o.to_dict() for o in top],
        }
