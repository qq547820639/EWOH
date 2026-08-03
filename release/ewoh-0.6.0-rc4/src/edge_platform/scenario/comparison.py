"""场景仿真层 — 方案对比。

对应 spec「场景仿真层」与「方案对比」场景：方案对比不应只显示总分，需展示分项指标。
spec 示例口径：「产能优先方案节拍提升 4.2% 但高负荷人员 3 人、低电量风险 2 台；
负荷均衡方案节拍提升 1.8% 但高负荷人员 0 人、低电量风险 0 台」。

本模块对比每个方案的所有分项指标，识别各指标最优方案，生成中文推荐理由（引用真实计算数值，
不虚构）。输出 Markdown 表格供指挥地图 UI「调度方案比较」页面展示（spec section 7.5）。

纯 Python 标准库实现。
"""

from dataclasses import dataclass, field

# 对比表展示的指标：(指标 key, 中文名, 是否越大越优)
_METRIC_SPECS = [
    ("estimated_output", "预计产量", True),
    ("on_time_probability", "准时率", True),
    ("delay_risk", "延误风险", False),
    ("high_load_persons_count", "高负荷人员数", False),
    ("total_travel_distance_m", "行走距离(米)", False),
    ("low_battery_devices_count", "低电量风险设备数", False),
    ("congestion_delta", "拥堵变化", False),
    ("confidence", "置信度", True),
]


@dataclass
class PlanComparison:
    """方案对比结果：方案列表 + 指标表 + 各指标最优方案 + 中文推荐。"""

    plans: list = field(default_factory=list)
    metric_table: list = field(default_factory=list)  # 每行：{metric_name, metric_key, plan_id: value}
    winner_by_metric: dict = field(default_factory=dict)  # metric_key -> plan_id
    recommendation: str = ""

    def to_dict(self):
        return {
            "plans": [p.to_dict() if hasattr(p, "to_dict") else p for p in self.plans],
            "metric_table": [dict(row) for row in self.metric_table],
            "winner_by_metric": dict(self.winner_by_metric),
            "recommendation": self.recommendation,
        }


def _metric_value(metrics, key):
    """从 PlanMetrics 取指标值；高负荷人员/低电量设备取计数。"""
    if metrics is None:
        return 0
    if key == "high_load_persons_count":
        return len(getattr(metrics, "high_load_persons", []) or [])
    if key == "low_battery_devices_count":
        return len(getattr(metrics, "low_battery_devices", []) or [])
    return float(getattr(metrics, key, 0.0) or 0.0)


def _fmt(value, key):
    """格式化指标值用于表格展示。"""
    if key in ("estimated_output", "total_travel_distance_m", "congestion_delta"):
        return f"{float(value):.1f}"
    if key in ("on_time_probability", "delay_risk", "confidence"):
        return f"{float(value):.3f}"
    return f"{float(value):g}"


def compare(plans):
    """对比多方案：构建分项指标表、识别各指标最优方案、生成中文推荐理由。

    plans: Plan 列表（至少 1 个）。返回 PlanComparison。
    """
    plans = list(plans or [])
    metric_table = []
    winner_by_metric = {}

    for key, label, higher_is_better in _METRIC_SPECS:
        row = {"metric_name": label, "metric_key": key}
        best_plan_id = None
        best_value = None
        for plan in plans:
            metrics = getattr(plan, "metrics", None)
            value = _metric_value(metrics, key)
            row[getattr(plan, "plan_id", "")] = value
            if best_value is None:
                best_value = value
                best_plan_id = getattr(plan, "plan_id", "")
            else:
                if higher_is_better and value > best_value + 1e-12:
                    best_value = value
                    best_plan_id = getattr(plan, "plan_id", "")
                elif not higher_is_better and value < best_value - 1e-12:
                    best_value = value
                    best_plan_id = getattr(plan, "plan_id", "")
        metric_table.append(row)
        winner_by_metric[key] = best_plan_id

    recommendation = _build_recommendation(plans, metric_table)

    return PlanComparison(
        plans=plans,
        metric_table=metric_table,
        winner_by_metric=winner_by_metric,
        recommendation=recommendation,
    )


def _build_recommendation(plans, metric_table):
    """生成中文推荐理由：引用真实计算数值，说明权衡（spec section 7.5 示例口径）。"""
    if not plans:
        return ""

    def val(plan_id, key):
        for row in metric_table:
            if row.get("metric_key") == key:
                return row.get(plan_id, 0)
        return 0

    by_type = {getattr(p, "plan_type", ""): p for p in plans}
    parts = [f"共 {len(plans)} 个方案，分项指标对比如下："]

    cap = by_type.get("CAPACITY_FIRST")
    safe = by_type.get("SAFETY_BALANCED")
    keep = by_type.get("KEEP_CURRENT")

    baseline_output = val(getattr(keep, "plan_id", ""), "estimated_output") if keep is not None else 0.0

    # 产能优先方案：节拍提升 / 高负荷人员 / 低电量风险（引用真实数值）
    if cap is not None:
        cap_id = getattr(cap, "plan_id", "")
        cap_out = val(cap_id, "estimated_output")
        cap_high = int(val(cap_id, "high_load_persons_count"))
        cap_low = int(val(cap_id, "low_battery_devices_count"))
        if baseline_output > 1e-9:
            uplift = (cap_out - baseline_output) / baseline_output * 100.0
            parts.append(
                f"产能优先方案节拍提升 {uplift:.1f}% 但高负荷人员 {int(cap_high)} 人、低电量风险 {int(cap_low)} 台；"
            )
        else:
            parts.append(
                f"产能优先方案预计产量 {cap_out:.1f} 但高负荷人员 {int(cap_high)} 人、低电量风险 {int(cap_low)} 台；"
            )

    # 负荷均衡方案：同口径对比（引用真实数值）
    if safe is not None:
        safe_id = getattr(safe, "plan_id", "")
        safe_out = val(safe_id, "estimated_output")
        safe_high = int(val(safe_id, "high_load_persons_count"))
        safe_low = int(val(safe_id, "low_battery_devices_count"))
        if baseline_output > 1e-9:
            uplift = (safe_out - baseline_output) / baseline_output * 100.0
            parts.append(
                f"负荷均衡方案节拍提升 {uplift:.1f}% 但高负荷人员 {int(safe_high)} 人、低电量风险 {int(safe_low)} 台。"
            )
        else:
            parts.append(
                f"负荷均衡方案预计产量 {safe_out:.1f} 但高负荷人员 {int(safe_high)} 人、低电量风险 {int(safe_low)} 台。"
            )

    # 推荐逻辑：首期安全优先——若负荷均衡方案高负荷人员为 0，倾向推荐；
    # 否则推荐产量最高方案（均需班组长确认，spec「人在回路」）。
    if safe is not None and val(getattr(safe, "plan_id", ""), "high_load_persons_count") == 0:
        parts.append(
            "综合安全与负荷均衡考虑，建议优先采用负荷均衡方案；如产能压力较大可由班组长确认后改用产能优先方案。"
        )
    elif cap is not None:
        parts.append("建议采用产能优先方案，但需关注高负荷人员与低电量设备风险，由班组长确认后执行。")
    return "".join(parts)


def format_comparison_table(comparison):
    """生成中文 Markdown 表格供指挥地图 UI「调度方案比较」展示（spec section 7.5）。

    comparison: PlanComparison（或 None）。
    """
    comparison = comparison or PlanComparison()
    plans = comparison.plans
    if not plans:
        return "（无方案可对比）"

    headers = ["指标"] + [getattr(p, "plan_type", getattr(p, "plan_id", "")) for p in plans]
    lines = []
    lines.append("| " + " | ".join(headers) + " |")
    lines.append("| " + " | ".join(["---"] * len(headers)) + " |")
    for row in comparison.metric_table:
        cells = [row.get("metric_name", "")]
        for p in plans:
            pid = getattr(p, "plan_id", "")
            value = row.get(pid, 0)
            cells.append(_fmt(value, row.get("metric_key", "")))
        lines.append("| " + " | ".join(cells) + " |")
    if comparison.recommendation:
        lines.append("")
        lines.append("推荐：" + comparison.recommendation)
    return "\n".join(lines)
