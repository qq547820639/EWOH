"""Canonical Capability Model（ADR-043 / §3/§4，NO-12t）。

机器/人员/外骨骼/工位能力的统一语义契约：
- kind/providerType 为封闭结构注册表（跨语言锁步，audit 门禁逐位比对）；
- name 为开放词表（工厂技能/能力名天然开放）——KNOWN_VALUES 是平台已知
  值登记（文档/测试向量锁定已知集合），未知 name 合法且显式（绝不静默
  改写）；validation 返回错误码列表（空=合法），fail-closed。
- certification 类：issuer + expiresAt 必填（证书判定事实完整，§33）；
  时间不倒退（expiresAt >= grantedAt）；subject 必须为规范身份形状
  （<prefix>:<value>，前缀语义由 identity 域深校验）；auditTrail 强制。
"""

CAPABILITY_KINDS = (
    "skill",
    "certification",
    "device_capability",
    "station_capability",
    "exo_capability",
)

PROVIDER_TYPES = (
    "person",
    "device",
    "exo",
    "machine",
    "robot",
    "station",
    "tool",
)

KNOWN_VALUES = (
    "forklift",
    "first_aid",
    "exo-lift",
    "vacuum",
    "assembly",
    "inspection",
    "material_handling",
)

_KIND_SET = frozenset(CAPABILITY_KINDS)
_PROVIDER_SET = frozenset(PROVIDER_TYPES)

_REQUIRED_FIELDS = (
    "capabilityId",
    "kind",
    "name",
    "providerType",
    "subject",
    "auditTrail",
)


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


def validate_capability(record):
    """CapabilityRecord 契约校验（fail-closed）；返回错误码列表（空=合法）。"""
    if not isinstance(record, dict):
        return ["record_must_be_object"]
    for field in _REQUIRED_FIELDS:
        if field not in record:
            return ["missing_field:" + field]
    if not isinstance(record.get("capabilityId"), str) or not record["capabilityId"].strip():
        return ["bad_capability_id"]
    kind = record.get("kind")
    if kind not in _KIND_SET:
        return ["unknown_kind"]
    name = record.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 100:
        return ["bad_name"]
    if record.get("providerType") not in _PROVIDER_SET:
        return ["unknown_provider_type"]
    subject = record.get("subject")
    if not isinstance(subject, str) or ":" not in subject or subject.startswith(":") or subject.endswith(":"):
        return ["bad_subject"]
    granted_at = record.get("grantedAt")
    expires_at = record.get("expiresAt")
    if granted_at is not None and _iso_ms(granted_at) is None:
        return ["bad_granted_at"]
    if expires_at is not None and _iso_ms(expires_at) is None:
        return ["bad_expires_at"]
    if kind == "certification":
        issuer = record.get("issuer")
        if not isinstance(issuer, str) or not issuer.strip():
            return ["certification_missing_issuer"]
        if _iso_ms(expires_at) is None:
            return ["certification_missing_expiry"]
    else:
        if record.get("issuer") is not None and (
            not isinstance(record.get("issuer"), str) or not record["issuer"].strip()
        ):
            return ["bad_issuer"]
    if granted_at is not None and expires_at is not None:
        g = _iso_ms(granted_at)
        e = _iso_ms(expires_at)
        if g is not None and e is not None and e < g:
            return ["time_order_violation"]
    evidence = record.get("evidence", [])
    if not isinstance(evidence, list):
        return ["bad_evidence"]
    for item in evidence:
        if not isinstance(item, str) or not item.strip():
            return ["bad_evidence"]
    if record.get("auditTrail") is not True:
        return ["audit_required"]
    return []
