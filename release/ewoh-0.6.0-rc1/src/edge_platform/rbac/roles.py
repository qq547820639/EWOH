"""角色定义（Task 28）。

对应 RBAC_matrix.csv 的角色收敛为 5 个平台角色：
- ADMIN：项目管理员（全部权限）。
- SAFETY_OFFICER：EHS 安全官（安全事件、审计、阈值/模型建议审批）。
- OPERATOR：运维（设备管理、设备事件、日志）。
- DATA_ANALYST：数据分析（查看与导出）。
- VIEWER：只读查看者。

纯 Python 标准库实现，零第三方依赖。
"""

from enum import Enum


class Role(str, Enum):
    """平台角色（字符串枚举，value 与 Settings.export_allowed_roles 对齐）。"""

    ADMIN = "admin"
    SAFETY_OFFICER = "safety_officer"
    OPERATOR = "operator"
    DATA_ANALYST = "data_analyst"
    VIEWER = "viewer"
