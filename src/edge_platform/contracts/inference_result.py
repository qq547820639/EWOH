"""Canonical Inference Result Model（统一模型推理结果契约，ADR-013 / NO-08a）。

权威契约：contracts/intelligence/inference-result.schema.json + test-vectors.json。
锁定注册表必须与 schema 一致，由 scripts/audit-domain-contracts.js 门禁强制。

语义：
- Level 1-7 分层工业智能的结果必须携带元数据（modelId/modelVersion/inputVersion/
  confidence/OOD/data quality/evidence）；
- confidence ∈ [0,1]，越界拒绝（fail-closed）；
- oodIndicator.flag=true 必须带 ≥1 个封闭注册表理由（六路）；flag=false 时
  reasons 必须为空；
- Unknown 是合法结果：label=unknown 必须携带 oodIndicator 理由；
- subjectId 必须是规范身份（ADR-006）。

零第三方依赖（pyproject dependencies=[]）。
"""

from __future__ import annotations

from typing import Any

from .identity import is_canonical_identity

LEVELS: tuple[str, ...] = (
    "L1_deterministic_rules",
    "L2_statistical_ml",
    "L3_optimization",
    "L4_industrial_reasoning",
    "L5_agentic_workflow",
    "L6_simulation_digital_twin",
    "L7_learning_loop",
)
OOD_REASONS: frozenset = frozenset(
    {
        "data_quality",
        "low_confidence",
        "ambiguous",
        "firmware_unverified",
        "out_of_distribution",
        "sensor_channel_missing",
    }
)
DATA_QUALITIES: frozenset = frozenset({"good", "degraded", "invalid"})


def validate_inference_result(record: Any) -> list[str]:
    """校验 InferenceResult 记录；返回错误码列表（空 = 合法）。fail-closed。"""
    if not isinstance(record, dict):
        return ["record_must_be_object"]
    for field in (
        "inferenceId",
        "subjectId",
        "level",
        "modelId",
        "modelVersion",
        "inputVersion",
        "label",
        "confidence",
        "oodIndicator",
        "dataQuality",
        "evidence",
    ):
        if field not in record:
            return [f"missing_field:{field}"]
    if not isinstance(record["inferenceId"], str) or not record["inferenceId"]:
        return ["bad_inference_id"]
    if not isinstance(record["subjectId"], str) or not is_canonical_identity(record["subjectId"]):
        return ["bad_subject"]
    if record["level"] not in LEVELS:
        return ["unknown_level"]
    for key in ("modelId", "modelVersion", "inputVersion"):
        if not isinstance(record[key], str) or not record[key]:
            return [f"bad_{key}"]
    if not isinstance(record["label"], str) or not record["label"]:
        return ["bad_label"]
    conf = record["confidence"]
    if not isinstance(conf, (int, float)) or isinstance(conf, bool) or conf < 0 or conf > 1:
        return ["bad_confidence"]
    ood = record["oodIndicator"]
    if not isinstance(ood, dict) or "flag" not in ood or "reasons" not in ood:
        return ["bad_ood_indicator"]
    flag = ood["flag"]
    reasons = ood["reasons"]
    if not isinstance(reasons, list) or any(not isinstance(r, str) for r in reasons):
        return ["bad_ood_indicator"]
    for r in reasons:
        if r not in OOD_REASONS:
            return ["unknown_ood_reason"]
    if flag is True and len(reasons) == 0:
        return ["ood_reason_required"]
    if flag is not True and len(reasons) > 0:
        return ["ood_flag_required"]
    if record["label"] == "unknown" and not (flag is True and len(reasons) > 0):
        return ["unknown_requires_ood"]
    if record["dataQuality"] not in DATA_QUALITIES:
        return ["bad_data_quality"]
    evidence = record["evidence"]
    if not isinstance(evidence, dict):
        return ["bad_evidence"]
    if "tsStart" not in evidence or "tsEnd" not in evidence or "isRule" not in evidence:
        return ["bad_evidence"]
    if not isinstance(evidence["isRule"], bool):
        return ["bad_evidence"]
    if not isinstance(evidence["tsStart"], str) or not isinstance(evidence["tsEnd"], str):
        return ["bad_evidence"]
    return []
