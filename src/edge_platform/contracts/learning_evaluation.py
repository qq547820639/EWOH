"""Canonical Learning Evaluation 契约（ADR-021 / NO-09a，Phase 12 Continuous Learning）。

权威契约：contracts/learning/learning-evaluation.schema.json +
learning-evaluation.test-vectors.json。锁定注册表必须与 schema 一致，由
scripts/audit-domain-contracts.js learning 域门禁强制。

语义（§28 Phase 12 + §10 + ADR-021）：
- 每 (org, 周期) 七项学习指标统一快照（metricRegistry 封闭注册表）；
- metrics 必须覆盖全部七键（缺键/未知键整体拒绝）；值 number|null——
  null 仅无数据或显式 unknown（modelAccuracy v1 恒定 null，绝不伪造）；
- periodEnd ≥ periodStart（ADR-009 时间语义同源）；basis 非空（§3）；
- auditTrail 必须 true；v1 观测层（绝不自动回写生产规则，§2）。

零第三方依赖（pyproject dependencies=[]）。
"""

from __future__ import annotations

import math
from typing import Any

METRIC_KEYS: tuple[str, ...] = (
    "recommendationAcceptanceRate", "planSuccessRate", "taskDelayP95Ms",
    "riskOutcomeRate", "humanOverrideRate", "modelAccuracy", "schedulerQualityRate",
)
EVALUATION_TYPES: tuple[str, ...] = ("periodic", "on_demand")
ENGINE_VERSION = "1.0.0"

_REQUIRED_FIELDS = (
    "evalId", "orgId", "evaluationType", "periodStart", "periodEnd",
    "engineVersion", "metrics", "basis", "auditTrail",
)


def _parse_iso(value: Any):
    from .envelope import parse_ts

    return parse_ts(value) if isinstance(value, str) else None


def validate_learning_evaluation(record: Any) -> list[str]:
    """校验学习评估快照；返回错误码列表（空 = 合法）。fail-closed。"""
    if not isinstance(record, dict):
        return ["record_must_be_object"]
    for field in _REQUIRED_FIELDS:
        if field not in record:
            return [f"missing_field:{field}"]
    if not isinstance(record["evalId"], str) or not record["evalId"]:
        return ["bad_eval_id"]
    if not isinstance(record["orgId"], str) or not record["orgId"]:
        return ["bad_org_id"]
    if record["evaluationType"] not in EVALUATION_TYPES:
        return ["unknown_evaluation_type"]
    start = _parse_iso(record["periodStart"])
    if start is None:
        return ["bad_period"]
    end = _parse_iso(record["periodEnd"])
    if end is None or end < start:
        return ["bad_period"]
    if not isinstance(record["engineVersion"], str) or not record["engineVersion"]:
        return ["bad_engine_version"]
    metrics = record["metrics"]
    if not isinstance(metrics, dict):
        return ["bad_metrics"]
    for key in METRIC_KEYS:
        if key not in metrics:
            return ["metric_missing"]
    for key, value in metrics.items():
        if key not in METRIC_KEYS:
            return ["unknown_metric"]
        # R2-SHR-003 / SH-009：补 isfinite（对齐 TS isFiniteNumber）。
        if value is not None and (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(value)
        ):
            return ["bad_metric_value"]
    basis = record["basis"]
    if not isinstance(basis, list) or len(basis) == 0:
        return ["basis_required"]
    # R2-SHR-010：空白串与空串同拒（对齐 TS item.trim() === ''）。
    if any(not isinstance(item, str) or not item.strip() for item in basis):
        return ["bad_basis"]
    if record["auditTrail"] is not True:
        return ["audit_required"]
    return []
