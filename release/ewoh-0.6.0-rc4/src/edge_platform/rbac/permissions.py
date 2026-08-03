"""权限矩阵与校验（Task 28）。

动作类型（9 种）：
- view_telemetry：查看遥测数据
- view_events：查看风险事件
- handle_events：处置风险事件
- export_data：导出数据
- manage_devices：管理设备
- manage_rules：管理风险规则
- manage_models：管理模型版本
- view_audit：查看审计日志
- manage_assignments：管理派工

权限矩阵依据 ``delivery/04_安全合规/RBAC_matrix.csv`` 收敛：
- ADMIN（项目管理员）：全部 True。
- SAFETY_OFFICER（EHS）：查看/处置安全事件、审计、阈值/模型建议审批、导出受限、派工。
- OPERATOR（运维）：设备管理、设备事件、日志导出、审计。
- DATA_ANALYST：查看遥测/事件、导出数据。
- VIEWER：只读查看遥测/事件。

``is_allowed(role, action)`` 接受 ``Role`` 枚举或角色字符串；
``check_export_role(role, allowed_roles)`` 用 ``Settings.export_allowed_roles`` 校验导出权限。

纯 Python 标准库实现，零第三方依赖。
"""

from edge_platform.rbac.roles import Role

# 动作常量
VIEW_TELEMETRY = "view_telemetry"
VIEW_EVENTS = "view_events"
HANDLE_EVENTS = "handle_events"
EXPORT_DATA = "export_data"
MANAGE_DEVICES = "manage_devices"
MANAGE_RULES = "manage_rules"
MANAGE_MODELS = "manage_models"
VIEW_AUDIT = "view_audit"
MANAGE_ASSIGNMENTS = "manage_assignments"

ALL_ACTIONS = (
    VIEW_TELEMETRY,
    VIEW_EVENTS,
    HANDLE_EVENTS,
    EXPORT_DATA,
    MANAGE_DEVICES,
    MANAGE_RULES,
    MANAGE_MODELS,
    VIEW_AUDIT,
    MANAGE_ASSIGNMENTS,
)

# 权限矩阵：PERMISSIONS[role_value][action] = bool
PERMISSIONS = {
    Role.ADMIN.value: {
        VIEW_TELEMETRY: True,
        VIEW_EVENTS: True,
        HANDLE_EVENTS: True,
        EXPORT_DATA: True,
        MANAGE_DEVICES: True,
        MANAGE_RULES: True,
        MANAGE_MODELS: True,
        VIEW_AUDIT: True,
        MANAGE_ASSIGNMENTS: True,
    },
    Role.SAFETY_OFFICER.value: {
        VIEW_TELEMETRY: True,
        VIEW_EVENTS: True,
        HANDLE_EVENTS: True,
        EXPORT_DATA: True,
        MANAGE_DEVICES: False,
        MANAGE_RULES: True,
        MANAGE_MODELS: True,
        VIEW_AUDIT: True,
        MANAGE_ASSIGNMENTS: True,
    },
    Role.OPERATOR.value: {
        VIEW_TELEMETRY: True,
        VIEW_EVENTS: True,
        HANDLE_EVENTS: True,
        EXPORT_DATA: True,
        MANAGE_DEVICES: True,
        MANAGE_RULES: False,
        MANAGE_MODELS: False,
        VIEW_AUDIT: True,
        MANAGE_ASSIGNMENTS: False,
    },
    Role.DATA_ANALYST.value: {
        VIEW_TELEMETRY: True,
        VIEW_EVENTS: True,
        HANDLE_EVENTS: False,
        EXPORT_DATA: True,
        MANAGE_DEVICES: False,
        MANAGE_RULES: False,
        MANAGE_MODELS: False,
        VIEW_AUDIT: False,
        MANAGE_ASSIGNMENTS: False,
    },
    Role.VIEWER.value: {
        VIEW_TELEMETRY: True,
        VIEW_EVENTS: True,
        HANDLE_EVENTS: False,
        EXPORT_DATA: False,
        MANAGE_DEVICES: False,
        MANAGE_RULES: False,
        MANAGE_MODELS: False,
        VIEW_AUDIT: False,
        MANAGE_ASSIGNMENTS: False,
    },
}


def _role_value(role) -> str:
    """Role 枚举或字符串统一转为角色值字符串。"""
    if isinstance(role, Role):
        return role.value
    return str(role)


def is_allowed(role, action) -> bool:
    """校验角色是否允许执行某动作。

    未知角色或动作返回 False。
    """
    role_value = _role_value(role)
    return PERMISSIONS.get(role_value, {}).get(action, False)


def check_export_role(role, allowed_roles) -> bool:
    """校验角色是否在导出允许名单内。

    ``allowed_roles`` 为 ``Settings.export_allowed_roles``（角色值字符串的可迭代对象）。
    """
    role_value = _role_value(role)
    return role_value in tuple(allowed_roles)
