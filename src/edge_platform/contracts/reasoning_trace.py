"""Canonical Industrial Reasoning Trace 契约（ADR-020 / NO-08b，Phase 8 Level 4）。

权威契约：contracts/reasoning/reasoning-trace.schema.json +
reasoning-trace.test-vectors.json。锁定注册表必须与 schema 一致，由
scripts/audit-domain-contracts.js reasoning_trace 域门禁强制。

语义（§10 Level 4 + §18 + ADR-020）：
- 独立工业推理层输出：结构化事实 → 结论的确定性推理轨迹；
- 结论可追溯：ruleId ∈ 封闭规则注册表 / premises 非空规范身份 /
  evidenceIds 非空规范身份（§3）/ severity ∈ canonical risk 阶梯
  （ADR-007 同源）/ confidenceBasis=deterministic 时 confidence 必须=1
  （确定性规则如实声明）；
- explanation 来自事实模板渲染（LLM 只允许翻译，不允许编造）；
- conclusions 空数组 = 无规则触发显式语义（§33 非 unknown 冒充 normal）；
- evaluate_rules：标准库确定性规则评估器（与 TS 生产引擎语义一致，
  Golden 第 15 场景跨语言仲裁）。

零第三方依赖（pyproject dependencies=[]）。
"""

from __future__ import annotations

import re
from typing import Any

from .identity import is_canonical_identity


def _safe_conclusion_value(raw: Any) -> str:
    """EDGE-227：把 trace_id 清洗为 conclusionId value 合法字符集。

    conclusionId 须满足规范身份 value 语法（无空白、无 ':'/'/'/'%'），原始
    trace_id 不保证满足——清洗掉非法字符（而非直接拼接产出违约 ID）。
    """
    cleaned = re.sub(r"[^A-Za-z0-9_.-]", "", str(raw))
    return cleaned[:100] or "unknown"


RULE_IDS: tuple[str, ...] = (
    "rule:worker-overload", "rule:exo-low-battery", "rule:machine-vibration-risk",
    "rule:material-shortage", "rule:station-quality-blocked", "rule:andon-escalation",
)
SEVERITIES: tuple[str, ...] = ("critical", "high", "medium", "low")
CONFIDENCE_BASES: tuple[str, ...] = ("deterministic", "statistical")
FACT_KINDS: tuple[str, ...] = ("person", "exo", "machine", "material", "station", "alert")

ENGINE_VERSION = "1.0.0"

_REQUIRED_FIELDS = ("traceId", "engineVersion", "factsRef", "conclusions", "auditTrail")
_CONCLUSION_FIELDS = (
    "conclusionId", "ruleId", "subjectId", "severity", "confidence",
    "confidenceBasis", "premises", "evidenceIds", "explanation",
)


def _bad_id_list(value: Any) -> bool:
    return not isinstance(value, list) or any(
        not isinstance(item, str) or not is_canonical_identity(item) for item in value
    )


def validate_reasoning_trace(record: Any) -> list[str]:
    """校验推理轨迹；返回错误码列表（空 = 合法）。fail-closed。"""
    if not isinstance(record, dict):
        return ["record_must_be_object"]
    for field in _REQUIRED_FIELDS:
        if field not in record:
            return [f"missing_field:{field}"]
    if not isinstance(record["traceId"], str) or not record["traceId"]:
        return ["bad_trace_id"]
    if not isinstance(record["engineVersion"], str) or not record["engineVersion"]:
        return ["bad_engine_version"]
    facts_ref = record["factsRef"]
    if not isinstance(facts_ref, dict):
        return ["bad_facts_ref"]
    snapshot = facts_ref.get("snapshotVersion")
    if not isinstance(snapshot, int) or isinstance(snapshot, bool) or snapshot < 0:
        return ["bad_facts_ref"]
    if _bad_id_list(facts_ref.get("eventIds")):
        return ["bad_facts_ref"]
    conclusions = record["conclusions"]
    if not isinstance(conclusions, list):
        return ["bad_conclusions"]
    seen_conclusion_ids: set[str] = set()
    for conclusion in conclusions:
        if not isinstance(conclusion, dict):
            return ["bad_conclusions"]
        for field in _CONCLUSION_FIELDS:
            if field not in conclusion:
                return [f"missing_field:{field}"]
        if not isinstance(conclusion["conclusionId"], str) or not is_canonical_identity(conclusion["conclusionId"]):
            return ["bad_conclusion_id"]
        if conclusion["ruleId"] not in RULE_IDS:
            return ["unknown_rule"]
        if not isinstance(conclusion["subjectId"], str) or not is_canonical_identity(conclusion["subjectId"]):
            return ["bad_subject"]
        if conclusion["severity"] not in SEVERITIES:
            return ["unknown_severity"]
        confidence = conclusion["confidence"]
        if (
            not isinstance(confidence, (int, float))
            or isinstance(confidence, bool)
            or confidence < 0
            or confidence > 1
        ):
            return ["bad_confidence"]
        basis = conclusion["confidenceBasis"]
        if basis not in CONFIDENCE_BASES:
            return ["bad_confidence_basis"]
        if basis == "deterministic" and confidence != 1:
            return ["bad_confidence"]
        premises = conclusion["premises"]
        if not isinstance(premises, list) or len(premises) == 0:
            return ["empty_premises"]
        if _bad_id_list(premises):
            return ["bad_premise"]
        evidence = conclusion["evidenceIds"]
        if not isinstance(evidence, list) or len(evidence) == 0:
            return ["empty_evidence"]
        if _bad_id_list(evidence):
            return ["bad_evidence_ref"]
        if not isinstance(conclusion["explanation"], str) or not conclusion["explanation"].strip():
            return ["bad_explanation"]
        # R2-SHR-011：conclusionId 在 conclusions 内必须唯一（多主体命中
        # 同规则时由 subjectId 段区分；重复 ID 会导致台账互相覆盖）。
        if conclusion["conclusionId"] in seen_conclusion_ids:
            return ["duplicate_conclusion_id"]
        seen_conclusion_ids.add(conclusion["conclusionId"])
    if record["auditTrail"] is not True:
        return ["audit_required"]
    return []


# ============================================================================
# 确定性规则评估器（标准库独立实现，Golden 第 15 场景跨语言仲裁）。
# 语义与 ewoh-spark-app/shared/reasoning-trace.ts evaluateReasoningRules
# 逐条一致：规则按注册表顺序评估，结论确定性排序。
# ============================================================================

RULE_TEMPLATES: dict[str, str] = {
    "rule:worker-overload":
        "人员 {subject} 负荷 {workload}，疲劳 {fatigue}，工效风险 {ergonomic}——建议轮换或减负（人工复核）",
    "rule:exo-low-battery":
        "外骨骼 {subject} 电量 {battery}%——建议换电或下线充电",
    "rule:machine-vibration-risk":
        "设备 {subject} 振动阈值超限——建议停机检查（人工复核，勿自动处置）",
    "rule:material-shortage":
        "物料 {subject} 库存 {inventory} 低于安全阈值 {threshold}——建议补料",
    "rule:station-quality-blocked":
        "工位 {subject} 存在活跃质量封锁——禁止派工（人审解除）",
    "rule:andon-escalation":
        "安灯 {subject} 未确认 {minutes} 分钟——升级值班长",
}


def evaluate_rules(
    trace_id: str, facts: list[dict], snapshot_version: int = 0, thresholds: dict | None = None,
) -> list[dict]:
    """确定性规则评估（返回 conclusions；facts 形状与 TS 引擎一致）。

    thresholds 为 ADR-026 人审激活的阈值覆盖（缺省 = 引擎内置常量），
    键 ∈ {workload, fatigue, ergonomicRisk}。
    """
    by_kind: dict[str, dict] = {f["subjectId"]: f for f in facts}
    conclusions: list[dict] = []
    for rule_id in RULE_IDS:
        matched = _match_rule(rule_id, by_kind, thresholds)
        for fact in matched:
            values = fact.get("values", {})
            explanation = RULE_TEMPLATES[rule_id].format(
                subject=fact["subjectId"],
                workload=_fmt(values.get("workload")),
                fatigue=_fmt(values.get("fatigue")),
                ergonomic=_fmt(values.get("ergonomicRisk")),
                battery=_fmt(values.get("batteryPct")),
                inventory=_fmt(values.get("inventory")),
                threshold=_fmt(values.get("minThreshold")),
                minutes=_fmt(values.get("unacknowledgedMinutes")),
            )
            conclusions.append({
                # EDGE-227 + R2-SHR-011：trace_id/subjectId 先经
                # _safe_conclusion_value 清洗保证规范身份 value 语法，且
                # subjectId 参与 ID 拼接——同规则多主体命中时不再碰撞
                # （与 TS safeConclusionValue 逐字节一致）。
                "conclusionId": (
                    f"decision:{_safe_conclusion_value(trace_id)}-{rule_id.split(':')[1]}"
                    f"-{_safe_conclusion_value(fact['subjectId'])}"
                ),
                "ruleId": rule_id,
                "subjectId": fact["subjectId"],
                "severity": _SEVERITY_OF[rule_id],
                "confidence": 1,
                "confidenceBasis": "deterministic",
                "premises": [fact["subjectId"]],
                "evidenceIds": fact.get("evidenceIds", []),
                "explanation": explanation,
            })
    return conclusions


_SEVERITY_OF: dict[str, str] = {
    "rule:worker-overload": "high",
    "rule:exo-low-battery": "high",
    "rule:machine-vibration-risk": "critical",
    "rule:material-shortage": "high",
    "rule:station-quality-blocked": "critical",
    "rule:andon-escalation": "high",
}


def _fmt(value: Any) -> Any:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else "?"


def _match_rule(rule_id: str, by_kind: dict[str, dict], thresholds: dict | None = None) -> list[dict]:
    workload_bound = 0.8 if not thresholds else thresholds.get("workload", 0.8)
    fatigue_bound = 0.7 if not thresholds else thresholds.get("fatigue", 0.7)
    ergonomic_bound = 0.7 if not thresholds else thresholds.get("ergonomicRisk", 0.7)
    matched: list[dict] = []
    for fact in by_kind.values():
        values = fact.get("values", {})
        if rule_id == "rule:worker-overload" and fact.get("kind") == "person":
            if _ge(values.get("workload"), workload_bound) and (
                _ge(values.get("fatigue"), fatigue_bound) or _ge(values.get("ergonomicRisk"), ergonomic_bound)
            ):
                matched.append(fact)
        elif rule_id == "rule:exo-low-battery" and fact.get("kind") == "exo":
            if _lt(values.get("batteryPct"), 20):
                matched.append(fact)
        elif rule_id == "rule:machine-vibration-risk" and fact.get("kind") == "machine":
            if values.get("vibrationExceeded") is True:
                matched.append(fact)
        elif rule_id == "rule:material-shortage" and fact.get("kind") == "material":
            if _num(values.get("inventory")) is not None and _num(values.get("minThreshold")) is not None \
                    and _num(values["inventory"]) < _num(values["minThreshold"]):
                matched.append(fact)
        elif rule_id == "rule:station-quality-blocked" and fact.get("kind") == "station":
            if values.get("qualityBlocked") is True:
                matched.append(fact)
        elif rule_id == "rule:andon-escalation" and fact.get("kind") == "alert":
            if values.get("andonRaised") is True and _gt(values.get("unacknowledgedMinutes"), 15):
                matched.append(fact)
    return matched


def _num(value: Any):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _ge(value: Any, bound: float) -> bool:
    num = _num(value)
    return num is not None and num >= bound


def _gt(value: Any, bound: float) -> bool:
    num = _num(value)
    return num is not None and num > bound


def _lt(value: Any, bound: float) -> bool:
    num = _num(value)
    return num is not None and num < bound
