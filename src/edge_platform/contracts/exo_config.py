"""Canonical Exo Configuration Model（ADR-051 / §7，NO-13b）。

外骨骼 Support Mode / Assist Profile / Fit / Calibration 跨运行时契约
（ewoh:///exo/exo-config/v1）：
- kind/supportMode/calibrationKind 为封闭结构注册表；status 按 kind 封闭；
- vendor_specific 模式为显式桶（vendorModeName 必填——未知厂商模式合法
  且显式，绝不静默改写为平台模式，§33）；
- 判定事实完整（§33）：
  - assist_profile：supportMode 必填；parameters.assistLevel ∈[0,1]
    有限数值；effectiveFrom 必填 ISO；effectiveTo ≥ effectiveFrom；
    superseded 必带 supersededBy；
  - fit：personId 必填（person: 规范身份——fit 是设备↔人物理适配事实）；
    fittedAt 必填；fitter 必填（规范身份）；measuredValues 有限数值；
  - calibration：calibrationKind 必填；result 必填；calibratedAt/
    calibratedBy 必填；nextDueAt ≥ calibratedAt；
  - 公共：configId 前缀 exo-config:；exoId device: 规范身份；tenantId
    必填；auditTrail 非空强制（actor 规范身份 + action 非空 + at ISO）。
validation 返回错误码列表（空=合法），fail-closed。
"""

import math
import re

EXO_CONFIG_KINDS = (
    "assist_profile",
    "fit",
    "calibration",
)

SUPPORT_MODES = (
    "passive",
    "lift_assist",
    "carry_assist",
    "stand_assist",
    "balance_assist",
    "upper_limb_assist",
    "lower_limb_assist",
    "vendor_specific",
)

CALIBRATION_KINDS = (
    "zeroing",
    "load_cell",
    "imu",
)

PROFILE_STATUSES = (
    "active",
    "superseded",
    "retired",
)

FIT_STATUSES = (
    "pending",
    "fitted",
    "adjusted",
    "invalidated",
)

CALIBRATION_STATUSES = (
    "pending",
    "passed",
    "failed",
)

_KIND_SET = frozenset(EXO_CONFIG_KINDS)
_MODE_SET = frozenset(SUPPORT_MODES)
_CAL_KIND_SET = frozenset(CALIBRATION_KINDS)
_PROFILE_STATUS_SET = frozenset(PROFILE_STATUSES)
_FIT_STATUS_SET = frozenset(FIT_STATUSES)
_CAL_STATUS_SET = frozenset(CALIBRATION_STATUSES)

_STATUS_BY_KIND = {
    "assist_profile": _PROFILE_STATUS_SET,
    "fit": _FIT_STATUS_SET,
    "calibration": _CAL_STATUS_SET,
}

_CANONICAL_ACTOR = re.compile(r"^[a-z][a-z0-9_]*:[^\s]+$")
_CONFIG_ID = re.compile(r"^exo-config:[^\s]+$")
_EXO_ID = re.compile(r"^device:[^\s]+$")
_PERSON_ID = re.compile(r"^person:[^\s]+$")

_REQUIRED_FIELDS = ("configId", "kind", "exoId", "tenantId", "status", "auditTrail")


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
    # R2-SHR-003：补 math.isfinite（对齐 TS isFiniteNumber，NaN/Inf 一律拒绝）。
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _finite_map(value):
    if not isinstance(value, dict):
        return False
    return all(_is_finite_number(v) for v in value.values())


def validate_exo_config(record):
    """ExoConfigRecord 契约校验（fail-closed）；返回错误码列表（空=合法）。"""
    if not isinstance(record, dict):
        return ["record_must_be_object"]
    for field in _REQUIRED_FIELDS:
        if field not in record:
            return ["missing_field:" + field]
    config_id = record.get("configId")
    if not isinstance(config_id, str) or not _CONFIG_ID.match(config_id):
        return ["bad_config_id"]
    kind = record.get("kind")
    if kind not in _KIND_SET:
        return ["unknown_kind"]
    exo_id = record.get("exoId")
    if not isinstance(exo_id, str) or not _EXO_ID.match(exo_id):
        return ["bad_exo_id"]
    tenant_id = record.get("tenantId")
    if not isinstance(tenant_id, str) or not tenant_id.strip():
        return ["bad_tenant"]
    status = record.get("status")
    if status not in _STATUS_BY_KIND[kind]:
        return ["unknown_status"]

    if kind == "assist_profile":
        mode = record.get("supportMode")
        if mode not in _MODE_SET:
            return ["unknown_support_mode"]
        if mode == "vendor_specific":
            name = record.get("vendorModeName")
            if not isinstance(name, str) or not name.strip():
                return ["vendor_mode_name_required"]
        else:
            name = record.get("vendorModeName")
            if name is not None and (not isinstance(name, str) or not name.strip()):
                return ["bad_vendor_mode_name"]
        parameters = record.get("parameters")
        if parameters is not None:
            if not isinstance(parameters, dict):
                return ["bad_parameters"]
            level = parameters.get("assistLevel")
            if level is not None and (not _is_finite_number(level) or level < 0 or level > 1):
                return ["bad_assist_level"]
            torque = parameters.get("torqueLimitNm")
            if torque is not None and (not _is_finite_number(torque) or torque < 0):
                return ["bad_torque_limit"]
        effective_from = record.get("effectiveFrom")
        from_ms = _iso_ms(effective_from)
        if from_ms is None:
            return ["missing_field:effectiveFrom"] if effective_from is None else ["bad_effective_from"]
        effective_to = record.get("effectiveTo")
        if effective_to is not None:
            to_ms = _iso_ms(effective_to)
            if to_ms is None:
                return ["bad_effective_to"]
            if to_ms < from_ms:
                return ["time_order_violation"]
        if status == "superseded":
            superseded_by = record.get("supersededBy")
            if not isinstance(superseded_by, str) or not superseded_by.strip():
                return ["superseded_by_required"]
        set_by = record.get("setBy")
        if set_by is not None and (not isinstance(set_by, str) or not set_by.strip()):
            return ["bad_set_by"]
    elif kind == "fit":
        person_id = record.get("personId")
        if person_id is None:
            return ["fit_person_required"]
        if not isinstance(person_id, str) or not _PERSON_ID.match(person_id):
            return ["bad_person_id"]
        fitted_at = record.get("fittedAt")
        if fitted_at is None:
            return ["missing_field:fittedAt"]
        if _iso_ms(fitted_at) is None:
            return ["bad_fitted_at"]
        fitter = record.get("fitter")
        if fitter is None:
            return ["fitter_required"]
        if not isinstance(fitter, str) or not _CANONICAL_ACTOR.match(fitter):
            return ["bad_fitter"]
        measured = record.get("measuredValues")
        if measured is not None and not _finite_map(measured):
            return ["bad_measured_values"]
    elif kind == "calibration":
        cal_kind = record.get("calibrationKind")
        if cal_kind is None:
            return ["missing_field:calibrationKind"]
        if cal_kind not in _CAL_KIND_SET:
            return ["unknown_calibration_kind"]
        result = record.get("result")
        if result is None:
            return ["calibration_result_required"]
        if result not in _CAL_STATUS_SET:
            return ["unknown_calibration_result"]
        calibrated_at = record.get("calibratedAt")
        at_ms = _iso_ms(calibrated_at)
        if at_ms is None:
            return ["missing_field:calibratedAt"] if calibrated_at is None else ["bad_calibrated_at"]
        calibrated_by = record.get("calibratedBy")
        if calibrated_by is None:
            return ["calibrated_by_required"]
        if not isinstance(calibrated_by, str) or not _CANONICAL_ACTOR.match(calibrated_by):
            return ["bad_calibrated_by"]
        next_due = record.get("nextDueAt")
        if next_due is not None:
            due_ms = _iso_ms(next_due)
            if due_ms is None:
                return ["bad_next_due_at"]
            if due_ms < at_ms:
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
