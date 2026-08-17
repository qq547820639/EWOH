"""Canonical Outcome Annotation 契约（ADR-034 / §10 Level 7 + §12）。

权威契约：contracts/learning/outcome-annotation.schema.json +
outcome-annotation.test-vectors.json。锁定注册表必须与 schema 一致，由
scripts/audit-domain-contracts.js outcome_annotation 域门禁强制。

语义（§10 + ADR-034）：
- Decision→Outcome 结构化事实（学习回路模型腿的真值来源前置）；
- targetType/outcomeKind 封闭注册表；judgedBy 非空 + judgedAt ISO
  （判定事实完整，§33）；measured 值必须有限数值（缺省=显式不携带）；
- auditTrail 必须 true。

零第三方依赖（pyproject dependencies=[]）。
"""

from __future__ import annotations

import math
from datetime import datetime
from typing import Any

TARGET_TYPES: tuple[str, ...] = ("plan", "decision", "proposal", "agent_command")
OUTCOME_KINDS: tuple[str, ...] = ("success", "partial_success", "failure", "invalid")

_REQUIRED_FIELDS = ("annotationId", "targetType", "targetId", "outcomeKind", "judgedBy", "judgedAt", "auditTrail")


def _is_iso(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
        return True
    except ValueError:
        return False


def validate_outcome_annotation(record: Any) -> list[str]:
    """校验结果标注记录；返回错误码列表（空 = 合法）。fail-closed。"""
    if not isinstance(record, dict):
        return ["record_must_be_object"]
    for field in _REQUIRED_FIELDS:
        if field not in record:
            return [f"missing_field:{field}"]
    if not isinstance(record["annotationId"], str) or not record["annotationId"].strip():
        return ["bad_annotation_id"]
    if record["targetType"] not in TARGET_TYPES:
        return ["unknown_target_type"]
    if not isinstance(record["targetId"], str) or not record["targetId"].strip():
        return ["bad_target_id"]
    if record["outcomeKind"] not in OUTCOME_KINDS:
        return ["unknown_outcome_kind"]
    if not isinstance(record["judgedBy"], str) or not record["judgedBy"].strip():
        return ["judger_required"]
    if not _is_iso(record["judgedAt"]):
        return ["bad_judged_at"]
    measured = record.get("measured")
    if measured is not None:
        if not isinstance(measured, dict):
            return ["bad_measured"]
        for value in measured.values():
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                return ["bad_measured"]
            # EDGE-222：NaN/Inf 检查仅对 float 有意义——int 在 IEEE-754 语义下
            # 不可能是 NaN/Inf（math.isnan/math.isinf 对 int 恒 False），
            # 故 int 走此路径即为安全，无需额外检查。
            if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
                return ["bad_measured"]
    comment = record.get("comment")
    if comment is not None and not isinstance(comment, str):
        return ["bad_comment"]
    if record["auditTrail"] is not True:
        return ["audit_required"]
    return []
