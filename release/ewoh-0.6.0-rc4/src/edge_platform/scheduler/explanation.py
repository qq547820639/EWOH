"""理由生成：所有建议具有分项理由（spec 验收要求）。

对应 spec「决策与调度层」与「本地大模型角色约束」：解释必须引用结构化算法输出的真实结果，
不得虚构传感器数据或调度数值。本模块基于候选的 score_breakdown / violations 生成中文理由。

纯 Python 标准库实现。
"""

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Explanation:
    """解释结果：被解释对象（候选或方案）+ 中文理由列表 + 证据字典。"""

    candidate: Any = None
    reasons: list = field(default_factory=list)
    evidence: dict = field(default_factory=dict)

    def to_dict(self):
        return {
            "reasons": list(self.reasons),
            "evidence": dict(self.evidence),
        }


def _violation_fields(v):
    """兼容 ConstraintViolation 对象与 dict。"""
    if hasattr(v, "constraint_type"):
        return v.constraint_type, (v.reason if hasattr(v, "reason") else "")
    return v.get("constraint_type", ""), v.get("reason", "")


def explain_candidate(candidate):
    """解释单个候选：通过则给出评分主导因素，未通过则列出硬约束拦截原因。

    所有理由引用候选中真实计算值（评分、累计负荷、移动距离等），不虚构。
    """
    reasons = []
    evidence = {
        "candidate_id": getattr(candidate, "candidate_id", ""),
        "person_id": getattr(candidate, "person_id", ""),
        "passed": bool(getattr(candidate, "passed", False)),
    }

    violations = getattr(candidate, "violations", []) or []
    if violations:
        evidence["violations"] = [v.to_dict() if hasattr(v, "to_dict") else dict(v) for v in violations]
        evidence["score"] = getattr(candidate, "score", None)
        for v in violations:
            ctype, reason = _violation_fields(v)
            reasons.append(f"硬约束拦截[{ctype}]：{reason}")
        return Explanation(candidate=candidate, reasons=reasons, evidence=evidence)

    # 通过候选：基于真实评分明细给出主导因素
    bd = getattr(candidate, "score_breakdown", {}) or {}
    score = getattr(candidate, "score", None)
    evidence["score"] = score
    evidence["breakdown"] = dict(bd)

    if score is not None:
        reasons.append(f"综合评分 {float(score):.3f}")

    # 各加权贡献（真实计算值）
    contrib_pairs = [
        ("w1_production_contrib", "产量贡献"),
        ("w2_on_time_contrib", "准时率贡献"),
        ("w3_safety_contrib", "安全风险扣分"),
        ("w4_body_load_contrib", "人体负荷扣分"),
        ("w5_travel_contrib", "移动距离扣分"),
        ("w6_changeover_contrib", "换岗成本扣分"),
    ]
    contrib_strs = []
    for key, label in contrib_pairs:
        if key in bd and bd[key] is not None:
            contrib_strs.append(f"{label} {float(bd[key]):+.3f}")
    if contrib_strs:
        reasons.append("分项贡献：" + "、".join(contrib_strs))

    # 累计负荷：引用真实值，必要时给出低负荷工位建议（spec 示例口径）
    body_load = bd.get("body_load")
    if body_load is not None:
        baseline = bd.get("body_load_baseline", 0.5)
        if float(body_load) > float(baseline) + 1e-9:
            reasons.append(
                f"当前累计负荷 {float(body_load):.2f} 高于个人基线 {float(baseline):.2f}，建议安排低负荷工位"
            )
        else:
            reasons.append(f"当前累计负荷 {float(body_load):.2f} 处于可接受范围")

    # 移动距离（真实计算值）
    td = bd.get("travel_distance")
    if td is not None:
        reasons.append(f"到达工位移动距离 {float(td):.1f} 米")

    # 安全风险（真实计算值）
    sr = bd.get("safety_risk")
    if sr is not None and float(sr) > 1e-9:
        reasons.append(f"近期安全风险评分 {float(sr):.2f}，需关注")

    # 换岗成本
    cc = bd.get("changeover_cost")
    if cc is not None and float(cc) > 1e-9:
        reasons.append("本次为换岗，产生换岗成本")

    if not reasons:
        reasons.append("候选通过硬约束，无评分明细可解释")
    return Explanation(candidate=candidate, reasons=reasons, evidence=evidence)


def explain_plan(plan):
    """解释调度方案（供场景仿真层使用）：汇总方案中各候选的关键指标与理由。

    plan 可为 Candidate 列表或 {"candidates": [...], ...} 字典。
    """
    if isinstance(plan, dict):
        candidates = plan.get("candidates", []) or []
        meta = {k: v for k, v in plan.items() if k != "candidates"}
    else:
        candidates = list(plan) if plan is not None else []
        meta = {}

    reasons = []
    evidence = {"plan_size": len(candidates), "meta": meta}

    passed = [c for c in candidates if getattr(c, "passed", False)]
    failed = [c for c in candidates if not getattr(c, "passed", False)]
    evidence["passed_count"] = len(passed)
    evidence["failed_count"] = len(failed)

    if not candidates:
        reasons.append("方案为空，无可解释候选")
        return Explanation(candidate=plan, reasons=reasons, evidence=evidence)

    reasons.append(f"方案共 {len(candidates)} 个候选，其中 {len(passed)} 个通过硬约束、{len(failed)} 个被拦截")

    if passed:
        top = max(
            passed, key=lambda c: getattr(c, "score", None) if getattr(c, "score", None) is not None else float("-inf")
        )
        if getattr(top, "score", None) is not None:
            reasons.append(
                "推荐候选：人员 {} + 设备 {}，综合评分 {:.3f}".format(
                    getattr(top, "person_id", ""), getattr(top, "device_id", ""), float(top.score)
                )
            )
        # 附推荐候选的逐项理由
        for r in explain_candidate(top).reasons:
            reasons.append("  - " + r)

    if failed:
        # 概述主要拦截原因类型
        ctypes = {}
        for c in failed:
            for v in getattr(c, "violations", []) or []:
                ct, _ = _violation_fields(v)
                ctypes[ct] = ctypes.get(ct, 0) + 1
        summary = "、".join(f"{k}×{int(v)}" for k, v in sorted(ctypes.items()))
        reasons.append(f"被拦截候选主要原因：{summary}")

    return Explanation(candidate=plan, reasons=reasons, evidence=evidence)
