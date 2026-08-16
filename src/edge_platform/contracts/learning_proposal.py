"""Canonical Learning Proposal 契约（ADR-026 / NO-12b，§10 Level 7 + §12）。

权威契约：contracts/learning/learning-proposal.schema.json +
learning-proposal.test-vectors.json。锁定注册表必须与 schema 一致，由
scripts/audit-domain-contracts.js learning_proposal 域门禁强制。

语义（ADR-026 + §2）：
- kind ∈ 封闭注册表 {rule_threshold}——v1 只有具备确定性影子评估器的类型
  （§33 绝不注册无引擎空类型；policy_weight/model 激活类待评估器落地再扩展）；
- status 状态机：proposed→shadow_evaluated→approved→rolled_back /
  proposed|shadow_evaluated→rejected（proposal_transition_allowed）；
- 影子评估前置：shadow_evaluated/approved/rolled_back 必须带 shadowEval
  ——无影子证据的激活在验证层即被拒绝（§33）；
- 激活阶梯 = 人审：approved 必须 approvedBy 非空 + approvedAt ISO
  （§2 绝不隐式自动执行）；rejected/rolled_back 必须带非空理由；
- THRESHOLD_RULES ⊆ reasoning-trace ruleRegistry（门禁交叉校验单一事实源）。

另含确定性影子评估器 evaluate_rule_threshold_shadow（§18：对历史事实窗口
按基线/候选阈值各重放一次 worker-overload 触发条件，输出 fired 计数 +
added/removed 主体 + riskLevel；与 TS 端逐项一致，Golden #20 + 门禁独立
JS 仲裁跨语言强制）。

零第三方依赖（pyproject dependencies=[]）。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

KINDS: tuple[str, ...] = ("rule_threshold",)
STATUSES: tuple[str, ...] = ("proposed", "shadow_evaluated", "approved", "rolled_back", "rejected")
THRESHOLD_RULES: tuple[tuple[str, str], ...] = (
    ("rule:worker-overload", "workloadThreshold"),
)

# worker-overload 触发条件的固定常量（与 reasoning_trace 引擎一致）：
# workload ≥ threshold 且 (fatigue ≥ 0.7 或 ergonomicRisk ≥ 0.7)。
FATIGUE_BOUND = 0.7
ERGONOMIC_BOUND = 0.7

_TRANSITIONS: dict[str, tuple[str, ...]] = {
    "proposed": ("shadow_evaluated", "rejected"),
    "shadow_evaluated": ("approved", "rejected"),
    "approved": ("rolled_back",),
    "rolled_back": (),
    "rejected": (),
}

_REQUIRED_FIELDS = ("proposalId", "kind", "status", "change", "auditTrail")
_CHANGE_FIELDS = ("ruleId", "parameter", "baselineValue", "candidateValue")


def _is_iso(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
        return True
    except ValueError:
        return False


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _valid_shadow(shadow: Any) -> bool:
    if not isinstance(shadow, dict):
        return False
    for field in ("baselineThreshold", "candidateThreshold", "factsCount", "baselineFires", "candidateFires"):
        if field not in shadow:
            return False
    if not _is_number(shadow["baselineThreshold"]) or not _is_number(shadow["candidateThreshold"]):
        return False
    for field in ("factsCount", "baselineFires", "candidateFires"):
        if not isinstance(shadow[field], int) or isinstance(shadow[field], bool) or shadow[field] < 0:
            return False
    for field in ("addedSubjects", "removedSubjects"):
        if not isinstance(shadow.get(field), list) or any(
            not isinstance(x, str) or not x for x in shadow[field]
        ):
            return False
    if shadow.get("riskLevel") not in ("low", "medium", "high"):
        return False
    return True


def validate_learning_proposal(record: Any) -> list[str]:
    """校验学习提案记录；返回错误码列表（空 = 合法）。fail-closed。"""
    if not isinstance(record, dict):
        return ["record_must_be_object"]
    for field in _REQUIRED_FIELDS:
        if field not in record:
            return [f"missing_field:{field}"]
    if not isinstance(record["proposalId"], str) or not record["proposalId"].strip():
        return ["bad_proposal_id"]
    if record["kind"] not in KINDS:
        return ["unknown_kind"]
    if record["status"] not in STATUSES:
        return ["unknown_status"]
    change = record["change"]
    if not isinstance(change, dict):
        return ["bad_change"]
    for field in _CHANGE_FIELDS:
        if field not in change:
            return [f"missing_field:{field}"]
    if (change["ruleId"], change["parameter"]) not in THRESHOLD_RULES:
        return ["unsupported_threshold"]
    if not _is_number(change["baselineValue"]) or not _is_number(change["candidateValue"]):
        return ["bad_change"]
    if not (0 <= change["baselineValue"] <= 1) or not (0 <= change["candidateValue"] <= 1):
        return ["bad_change"]
    if change["baselineValue"] == change["candidateValue"]:
        return ["no_op_change"]
    status = record["status"]
    if status in ("shadow_evaluated", "approved", "rolled_back"):
        if not _valid_shadow(record.get("shadowEval")):
            return ["shadow_eval_required"]
    if status == "approved":
        if not isinstance(record.get("approvedBy"), str) or not record["approvedBy"].strip():
            return ["approver_required"]
        if not _is_iso(record.get("approvedAt")):
            return ["approval_time_required"]
    if status == "rejected":
        if not isinstance(record.get("rejectedBy"), str) or not record["rejectedBy"].strip():
            return ["rejecter_required"]
        if not isinstance(record.get("rejectedReason"), str) or not record["rejectedReason"].strip():
            return ["reject_reason_required"]
    if status == "rolled_back":
        if not isinstance(record.get("rolledBackBy"), str) or not record["rolledBackBy"].strip():
            return ["rollback_by_required"]
        if not isinstance(record.get("rolledBackReason"), str) or not record["rolledBackReason"].strip():
            return ["rollback_reason_required"]
    eval_ref = record.get("evaluationRef")
    if eval_ref is not None:
        if not isinstance(eval_ref, dict) or not isinstance(eval_ref.get("evalId"), str):
            return ["bad_evaluation_ref"]
    if record["auditTrail"] is not True:
        return ["audit_required"]
    return []


def proposal_transition_allowed(from_status: str, to_status: str) -> bool:
    """ADR-026 状态机（与 TS 端一致）。"""
    return to_status in _TRANSITIONS.get(from_status, ())


# ---------------------------------------------------------------------------
# 确定性影子评估器（ADR-026 决策 2；Golden #20 + 门禁独立 JS 仲裁）。
# ---------------------------------------------------------------------------

def evaluate_rule_threshold_shadow(
    rule_id: str, baseline_threshold: float, candidate_threshold: float, facts: list[Any],
) -> dict[str, Any]:
    """历史重放影子评估：worker-overload 在基线/候选阈值下的触发差集。

    facts: person 事实 [{subjectId, kind:'person', values:{workload, fatigue,
    ergonomicRisk}, evidenceIds}]；阈值 ∈ [0,1] 且基线 ≠ 候选（fail-closed）。
    riskLevel：removed 非空且阈值放宽 ≥ 0.15 → high；removed 非空 → medium；
    否则 low（收紧阈值只增保护）。与 TS 端逐项一致。
    """
    if rule_id != "rule:worker-overload":
        raise ValueError(f"unsupported_threshold:{rule_id}")
    if not _is_number(baseline_threshold) or not _is_number(candidate_threshold):
        raise ValueError("阈值必须是数值")
    if not (0 <= baseline_threshold <= 1) or not (0 <= candidate_threshold <= 1):
        raise ValueError("阈值必须 ∈ [0,1]")
    if baseline_threshold == candidate_threshold:
        raise ValueError("基线阈值与候选阈值必须不同")
    if not isinstance(facts, list) or not facts:
        raise ValueError("facts 必须是非空列表")
    normalized = []
    for fact in facts:
        if not isinstance(fact, dict):
            raise ValueError("fact 必须是对象")
        subject_id = fact.get("subjectId")
        kind = fact.get("kind")
        values = fact.get("values")
        if not isinstance(subject_id, str) or not subject_id:
            raise ValueError("fact.subjectId 必须是非空字符串")
        if kind != "person":
            raise ValueError(f"unsupported_fact_kind:{kind!r}（worker-overload 仅评估 person 事实）")
        if not isinstance(values, dict):
            raise ValueError("fact.values 必须是对象")
        workload = values.get("workload")
        fatigue = values.get("fatigue")
        ergonomic = values.get("ergonomicRisk")
        if not _is_number(workload) or not _is_number(fatigue) or not _is_number(ergonomic):
            raise ValueError("fact.values 必须含数值 workload/fatigue/ergonomicRisk")
        normalized.append({
            "subjectId": subject_id,
            "workload": float(workload),
            "fatigue": float(fatigue),
            "ergonomicRisk": float(ergonomic),
        })

    def _fires(threshold: float) -> set[str]:
        return {
            f["subjectId"] for f in normalized
            if f["workload"] >= threshold
            and (f["fatigue"] >= FATIGUE_BOUND or f["ergonomicRisk"] >= ERGONOMIC_BOUND)
        }

    baseline = _fires(float(baseline_threshold))
    candidate = _fires(float(candidate_threshold))
    added = sorted(candidate - baseline)
    removed = sorted(baseline - candidate)
    if removed and (float(candidate_threshold) - float(baseline_threshold)) >= 0.15:
        risk = "high"
    elif removed:
        risk = "medium"
    else:
        risk = "low"
    return {
        "baselineThreshold": float(baseline_threshold),
        "candidateThreshold": float(candidate_threshold),
        "factsCount": len(normalized),
        "baselineFires": len(baseline),
        "candidateFires": len(candidate),
        "addedSubjects": added,
        "removedSubjects": removed,
        "riskLevel": risk,
    }
