"""Canonical Reasoning Result Model（Level 4/5 文本结果契约，ADR-014 / NO-08c）。

权威契约：contracts/reasoning/reasoning-result.schema.json + test-vectors.json。
锁定注册表必须与 schema 一致，由 scripts/audit-domain-contracts.js 门禁强制。

语义：
- LLM/Ark 文本结果（建议/解释/分析/聊天）无标定置信度——confidence 必须为
  null（禁止伪造，出现数值即拒绝 confidence_forbidden）；
- confidenceBasis 必须显式为 uncalibrated（拒绝缺省）；
- ok=false 必须带非空 error；ok=true 时 error 必须为 null、content 必填非空；
- subjectId null 合法（无主体）或规范身份（ADR-006）；
- evidence.generatedAt 必填 ISO 时间戳。

与 InferenceResult（统计判定，confidence 必填）显式分工，不混用。

零第三方依赖（pyproject dependencies=[]）。
"""

from __future__ import annotations

from typing import Any

from .identity import is_canonical_identity

LEVELS: tuple[str, ...] = ("L4_industrial_reasoning", "L5_agentic_workflow")
KINDS: frozenset = frozenset({"suggestion", "explanation", "analysis", "chat"})


def validate_reasoning_result(record: Any) -> list[str]:
    """校验 ReasoningResult 记录；返回错误码列表（空 = 合法）。fail-closed。"""
    if not isinstance(record, dict):
        return ["record_must_be_object"]
    for field in (
        "reasoningId",
        "level",
        "kind",
        "modelId",
        "modelVersion",
        "inputVersion",
        "subjectId",
        "content",
        "ok",
        "error",
        "confidence",
        "confidenceBasis",
        "evidence",
    ):
        if field not in record:
            return [f"missing_field:{field}"]
    if not isinstance(record["reasoningId"], str) or not record["reasoningId"]:
        return ["bad_reasoning_id"]
    if record["level"] not in LEVELS:
        return ["unknown_level"]
    if record["kind"] not in KINDS:
        return ["unknown_kind"]
    for key in ("modelId", "modelVersion", "inputVersion"):
        if not isinstance(record[key], str) or not record[key]:
            return [f"bad_{key}"]
    subject = record["subjectId"]
    if subject is not None and (
        not isinstance(subject, str) or not is_canonical_identity(subject)
    ):
        return ["bad_subject"]
    if not isinstance(record["content"], str):
        return ["bad_content"]
    ok = record["ok"]
    if not isinstance(ok, bool):
        return ["bad_ok"]
    error = record["error"]
    if ok is True:
        if not record["content"]:
            return ["empty_content"]
        if error is not None:
            return ["error_forbidden"]
    else:
        if not isinstance(error, str) or not error:
            return ["error_required"]
    if record["confidence"] is not None:
        return ["confidence_forbidden"]
    if record["confidenceBasis"] != "uncalibrated":
        return ["confidence_basis_required"]
    evidence = record["evidence"]
    if not isinstance(evidence, dict) or "generatedAt" not in evidence:
        return ["bad_evidence"]
    if not isinstance(evidence["generatedAt"], str) or not evidence["generatedAt"]:
        return ["bad_evidence"]
    return []
