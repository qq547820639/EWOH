"""角色与权限（Task 28）。

- roles：平台角色枚举。
- permissions：权限矩阵与 ``is_allowed`` / ``check_export_role``。

纯 Python 标准库实现，零第三方依赖。
"""

from edge_platform.rbac.permissions import (
    ALL_ACTIONS,
    EXPORT_DATA,
    HANDLE_EVENTS,
    MANAGE_ASSIGNMENTS,
    MANAGE_DEVICES,
    MANAGE_MODELS,
    MANAGE_RULES,
    PERMISSIONS,
    VIEW_AUDIT,
    VIEW_EVENTS,
    VIEW_TELEMETRY,
    check_export_role,
    is_allowed,
)
from edge_platform.rbac.roles import Role

__all__ = [
    "Role",
    "PERMISSIONS", "ALL_ACTIONS",
    "VIEW_TELEMETRY", "VIEW_EVENTS", "HANDLE_EVENTS", "EXPORT_DATA",
    "MANAGE_DEVICES", "MANAGE_RULES", "MANAGE_MODELS", "VIEW_AUDIT",
    "MANAGE_ASSIGNMENTS",
    "is_allowed", "check_export_role",
]
