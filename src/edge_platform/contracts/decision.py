# -*- coding: utf-8 -*-
"""Canonical Decision Model（ADR-047 / §2/§3/§18，NO-12x）。

跨运行时决策契约（ewoh:///decision/decision/v1）：
- kind/status/decisionAuthority 为封闭结构注册表（Decision Catalog v1，
  8 类决策 / 5 态生命周期 / 5 类权威，跨语言锁步，audit 门禁逐位比对）；
- riskLevel 复用 risk 契约 SEVERITY_LADDER（§31 单一事实源——本模块
  不重复定义，import 即事实源）；
- 判定事实完整（§33）：
  - decisionId 规范前缀 decision:；subject 规范身份形状（<prefix>:<value>，
    前缀语义深校验归 identity 域）；
  - tenantId 必填；requiresApproval 显式布尔；
  - selected.reason 非空强制（解释必须给出真实理由，§18）；
  - selected.optionId 必须在 options 中（选中的必是考虑过的）；
  - options 内 optionId 唯一；
  - decisionAuthority=human 或 status ∈ {approved, rejected} → approver
    {actor, at} 必填；approver.at >= decidedAt（时间不倒退）；
  - auditTrail 非空强制（actor 规范身份 + action 非空 + at ISO）。
validation 返回错误码列表（空=合法），fail-closed。
"""

import re

from .risk import SEVERITY_LADDER

DECISION_KINDS = (
    "task_assignment",
    "plan_approval",
    "agent_approval",
    "resource_reservation",
    "dispatch",
    "replan",
    "learning_proposal_activation",
    "policy_activation",
)

DECISION_STATUSES = (
    "proposed",
    "approved",
    "rejected",
    "executed",
    "superseded",
)

DECISION_AUTHORITIES = (
    "policy",
    "optimization",
    "rule_based",
    "human",
    "agent",
)

# §31：风险阶梯单一事实源 = risk 契约（不重复定义）。
RISK_LEVELS = SEVERITY_LADDER

_KIND_SET = frozenset(DECISION_KINDS)
_STATUS_SET = frozenset(DECISION_STATUSES)
_AUTHORITY_SET = frozenset(DECISION_AUTHORITIES)
_RISK_SET = frozenset(RISK_LEVELS)

_CANONICAL_ACTOR = re.compile(r"^[a-z][a-z0-9_]*:[^\s]+$")
_DECISION_ID = re.compile(r"^decision:[^\s]+$")

_REQUIRED_FIELDS = (
    "decisionId",
    "kind",
    "status",
    "decisionAuthority",
    "subject",
    "tenantId",
    "riskLevel",
    "requiresApproval",
    "decidedAt",
    "selected",
    "auditTrail",
)

_OPTIONAL_STRING_FIELDS = {
    "policyVersion": "bad_policy_version",
    "solverVersion": "bad_solver_version",
    "snapshotRef": "bad_snapshot_ref",
    "outcomeRef": "bad_outcome_ref",
}


def _iso_ms(value):
    """ISO 时间字符串 → epoch ms；无法解析返回 None（显式未知，不猜）。"""
    if not isinstance(value, str) or value == "":
        return None
    try:
        from datetime import datetime
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return int(dt.timestamp() * 1000)
    except (ValueError, AttributeError):
        return None


def _is_finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def validate_decision(record):
    """DecisionRecord 契约校验（fail-closed）；返回错误码列表（空=合法）。"""
    if not isinstance(record, dict):
        return ["record_must_be_object"]
    for field in _REQUIRED_FIELDS:
        if field not in record:
            return ["missing_field:" + field]
    decision_id = record.get("decisionId")
    if not isinstance(decision_id, str) or not _DECISION_ID.match(decision_id):
        return ["bad_decision_id"]
    if record.get("kind") not in _KIND_SET:
        return ["unknown_kind"]
    if record.get("status") not in _STATUS_SET:
        return ["unknown_status"]
    if record.get("decisionAuthority") not in _AUTHORITY_SET:
        return ["unknown_authority"]
    subject = record.get("subject")
    if not isinstance(subject, str) or not _CANONICAL_ACTOR.match(subject):
        return ["bad_subject"]
    tenant_id = record.get("tenantId")
    if not isinstance(tenant_id, str) or not tenant_id.strip():
        return ["bad_tenant"]
    if record.get("riskLevel") not in _RISK_SET:
        return ["unknown_risk_level"]
    if not isinstance(record.get("requiresApproval"), bool):
        return ["bad_approval_flag"]
    decided_at = record.get("decidedAt")
    decided_ms = _iso_ms(decided_at)
    if decided_ms is None:
        return ["bad_decided_at"]
    for field, error_code in _OPTIONAL_STRING_FIELDS.items():
        value = record.get(field)
        if value is not None and (not isinstance(value, str) or not value.strip()):
            return [error_code]

    options = record.get("options")
    option_ids = []
    if options is not None:
        if not isinstance(options, list):
            return ["bad_options"]
        for option in options:
            if not isinstance(option, dict):
                return ["bad_options"]
            option_id = option.get("optionId")
            if not isinstance(option_id, str) or not option_id.strip():
                return ["bad_option_id"]
            if option_id in option_ids:
                return ["duplicate_option"]
            option_ids.append(option_id)
            score = option.get("score")
            if score is not None and not _is_finite_number(score):
                return ["bad_options"]
            reasons = option.get("reasons", [])
            if not isinstance(reasons, list):
                return ["bad_options"]
            for reason in reasons:
                if not isinstance(reason, str) or not reason.strip():
                    return ["bad_options"]

    selected = record.get("selected")
    if not isinstance(selected, dict):
        return ["bad_selected"]
    selected_id = selected.get("optionId")
    if not isinstance(selected_id, str) or not selected_id.strip():
        return ["bad_option_id"]
    selected_reason = selected.get("reason")
    if (
        not isinstance(selected_reason, list)
        or len(selected_reason) == 0
        or any(not isinstance(r, str) or not r.strip() for r in selected_reason)
    ):
        return ["selected_reason_required"]
    if options is not None and selected_id not in option_ids:
        return ["unknown_selected_option"]

    rejected = record.get("rejectedAlternatives")
    if rejected is not None:
        if not isinstance(rejected, list):
            return ["bad_rejected"]
        for entry in rejected:
            if not isinstance(entry, dict):
                return ["bad_rejected"]
            entry_id = entry.get("optionId")
            if not isinstance(entry_id, str) or not entry_id.strip():
                return ["bad_option_id"]
            reject_reasons = entry.get("rejectReasons")
            if (
                not isinstance(reject_reasons, list)
                or len(reject_reasons) == 0
                or any(not isinstance(r, str) or not r.strip() for r in reject_reasons)
            ):
                return ["reject_reason_required"]

    hard_constraints = record.get("hardConstraints")
    if hard_constraints is not None:
        if not isinstance(hard_constraints, list) or any(
            not isinstance(c, str) or not c.strip() for c in hard_constraints
        ):
            return ["bad_hard_constraints"]

    weights = record.get("weightsSnapshot")
    if weights is not None:
        if not isinstance(weights, dict):
            return ["bad_weights"]
        for value in weights.values():
            if not _is_finite_number(value):
                return ["bad_weights"]

    evidence = record.get("evidence")
    if evidence is not None:
        if not isinstance(evidence, list) or any(
            not isinstance(e, str) or not e.strip() for e in evidence
        ):
            return ["bad_evidence"]

    # 审批判定事实：human 决策或 approved/rejected 状态必带 approver。
    # EDGE-221：合并双重 dict 检查为单次判定（approver 存在性 → bad_approver；
    # 判定需要但缺失 → approver_required）。
    approver = record.get("approver")
    needs_approver = (
        record.get("decisionAuthority") == "human"
        or record.get("status") in ("approved", "rejected")
    )
    if approver is None:
        if needs_approver:
            return ["approver_required"]
    else:
        if not isinstance(approver, dict):
            return ["bad_approver"]
        actor = approver.get("actor")
        if not isinstance(actor, str) or not _CANONICAL_ACTOR.match(actor):
            return ["bad_approver"]
        approver_ms = _iso_ms(approver.get("at"))
        if approver_ms is None:
            return ["bad_approver"]
        if approver_ms < decided_ms:
            return ["time_order_violation"]

    audit_trail = record.get("auditTrail")
    if not isinstance(audit_trail, list) or len(audit_trail) == 0:
        return ["audit_required"]
    for entry in audit_trail:
        if not isinstance(entry, dict):
            return ["bad_audit_entry"]
        actor = entry.get("actor")
        if not isinstance(actor, str) or not _CANONICAL_ACTOR.match(actor):
            return ["bad_audit_entry"]
        action = entry.get("action")
        if not isinstance(action, str) or not action.strip():
            return ["bad_audit_entry"]
        if _iso_ms(entry.get("at")) is None:
            return ["bad_audit_entry"]
    return []
