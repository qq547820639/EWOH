"""Canonical Risk Model（统一风险契约，ADR-007 / NO-02c）。

权威契约：contracts/risk/risk.schema.json + contracts/risk/test-vectors.json。
锁定注册表必须与 schema 一致，由 scripts/audit-domain-contracts.js 门禁强制。

语义：
- 规范严重度阶梯 critical > high > medium > low；
- legacy 映射 L1→critical / L2→high / L3→medium（边缘 sev_order L1 最严重）；
- 生命周期 open→acknowledged→resolving→resolved→closed；resolving/resolved→open
  允许（复开）；其余非法转移拒绝；
- category 封闭注册表；未知值一律拒绝（fail-closed，禁止猜测）。

零第三方依赖（pyproject dependencies=[]）。
"""

from __future__ import annotations

SEVERITY_LADDER: tuple[str, ...] = ("critical", "high", "medium", "low")
LEGACY_SEVERITY_MAP: dict[str, str] = {"L1": "critical", "L2": "high", "L3": "medium"}
LIFECYCLE: tuple[str, ...] = ("open", "acknowledged", "resolving", "resolved", "closed")
CATEGORIES: frozenset = frozenset(
    {
        "posture",
        "load",
        "battery",
        "offline",
        "sensor_degraded",
        "time_sync",
        "packet_loss",
        "action_anomaly",
        "quality",
        "equipment",
        "environment",
        "other",
    }
)

# 合法转移（含复开边）；其余一律拒绝。
_TRANSITIONS: frozenset = frozenset(
    {
        ("open", "acknowledged"),
        ("acknowledged", "resolving"),
        ("resolving", "resolved"),
        ("resolved", "closed"),
        ("resolving", "open"),
        ("resolved", "open"),
    }
)


class DomainContractError(ValueError):
    """域契约错误（fail-closed）。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def normalize_severity(value: str) -> str:
    """归一化严重度：规范值直通；legacy L1/L2/L3 → 规范；未知拒绝。"""
    if value in SEVERITY_LADDER:
        return value
    mapped = LEGACY_SEVERITY_MAP.get(value)
    if mapped is not None:
        return mapped
    raise DomainContractError("unknown_severity", f"未知严重度（非规范值亦非 legacy L1-L3）: {value!r}")


def severity_rank(value: str) -> int:
    """严重度等级（越大越严重）。"""
    return len(SEVERITY_LADDER) - SEVERITY_LADDER.index(normalize_severity(value))


def severity_higher_than(a: str, b: str) -> bool:
    """a 是否比 b 更严重。"""
    return severity_rank(a) > severity_rank(b)


def is_valid_category(value: str) -> bool:
    return value in CATEGORIES


def require_category(value: str) -> str:
    if not is_valid_category(value):
        raise DomainContractError("unknown_category", f"category 不在注册表: {value!r}")
    return value


def is_valid_status(value: str) -> bool:
    return value in LIFECYCLE


def transition_allowed(from_status: str, to_status: str) -> bool:
    """状态转移合法性（含复开边）；未知状态一律非法。"""
    if not is_valid_status(from_status) or not is_valid_status(to_status):
        return False
    return (from_status, to_status) in _TRANSITIONS
