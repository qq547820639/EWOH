"""权限矩阵与校验（Task 28）。

动作类型（14 种）：
- view_telemetry：查看遥测数据
- view_events：查看风险事件
- view_personnel：查看人员档案（PII，viewer 不可见）
- handle_events：处置风险事件
- export_data：导出数据
- manage_devices：管理设备
- manage_rules：管理风险规则
- manage_models：管理模型版本
- view_audit：查看审计日志
- manage_assignments：管理派工
- manage_data：管理平台数据（演示重置等破坏性数据操作，仅 admin）
- manage_world：写世界模型状态/事件/预测（仅 admin）
- query_assistant：本地白名单助手问答
- raise_andon：现场安灯开灯

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
VIEW_PERSONNEL = "view_personnel"
HANDLE_EVENTS = "handle_events"
EXPORT_DATA = "export_data"
MANAGE_DEVICES = "manage_devices"
MANAGE_RULES = "manage_rules"
MANAGE_MODELS = "manage_models"
VIEW_AUDIT = "view_audit"
MANAGE_ASSIGNMENTS = "manage_assignments"
MANAGE_DATA = "manage_data"
MANAGE_WORLD = "manage_world"
QUERY_ASSISTANT = "query_assistant"
RAISE_ANDON = "raise_andon"

ALL_ACTIONS = (
    VIEW_TELEMETRY,
    VIEW_EVENTS,
    VIEW_PERSONNEL,
    HANDLE_EVENTS,
    EXPORT_DATA,
    MANAGE_DEVICES,
    MANAGE_RULES,
    MANAGE_MODELS,
    VIEW_AUDIT,
    MANAGE_ASSIGNMENTS,
    MANAGE_DATA,
    MANAGE_WORLD,
    QUERY_ASSISTANT,
    RAISE_ANDON,
)

# 权限矩阵：PERMISSIONS[role_value][action] = bool
PERMISSIONS = {
    Role.ADMIN.value: {
        VIEW_TELEMETRY: True,
        VIEW_EVENTS: True,
        VIEW_PERSONNEL: True,
        HANDLE_EVENTS: True,
        EXPORT_DATA: True,
        MANAGE_DEVICES: True,
        MANAGE_RULES: True,
        MANAGE_MODELS: True,
        VIEW_AUDIT: True,
        MANAGE_ASSIGNMENTS: True,
        MANAGE_DATA: True,
        MANAGE_WORLD: True,
        QUERY_ASSISTANT: True,
        RAISE_ANDON: True,
    },
    Role.SAFETY_OFFICER.value: {
        VIEW_TELEMETRY: True,
        VIEW_EVENTS: True,
        VIEW_PERSONNEL: True,
        HANDLE_EVENTS: True,
        EXPORT_DATA: True,
        MANAGE_DEVICES: False,
        MANAGE_RULES: True,
        MANAGE_MODELS: True,
        VIEW_AUDIT: True,
        MANAGE_ASSIGNMENTS: True,
        MANAGE_DATA: False,
        MANAGE_WORLD: False,
        QUERY_ASSISTANT: True,
        RAISE_ANDON: True,
    },
    Role.OPERATOR.value: {
        VIEW_TELEMETRY: True,
        VIEW_EVENTS: True,
        VIEW_PERSONNEL: True,
        HANDLE_EVENTS: True,
        EXPORT_DATA: True,
        MANAGE_DEVICES: True,
        MANAGE_RULES: False,
        MANAGE_MODELS: False,
        VIEW_AUDIT: True,
        MANAGE_ASSIGNMENTS: False,
        MANAGE_DATA: False,
        MANAGE_WORLD: False,
        QUERY_ASSISTANT: True,
        RAISE_ANDON: True,
    },
    Role.DATA_ANALYST.value: {
        VIEW_TELEMETRY: True,
        VIEW_EVENTS: True,
        VIEW_PERSONNEL: True,
        HANDLE_EVENTS: False,
        EXPORT_DATA: True,
        MANAGE_DEVICES: False,
        MANAGE_RULES: False,
        MANAGE_MODELS: False,
        VIEW_AUDIT: False,
        MANAGE_ASSIGNMENTS: False,
        MANAGE_DATA: False,
        MANAGE_WORLD: False,
        QUERY_ASSISTANT: True,
        RAISE_ANDON: False,
    },
    Role.VIEWER.value: {
        VIEW_TELEMETRY: True,
        VIEW_EVENTS: True,
        VIEW_PERSONNEL: False,
        HANDLE_EVENTS: False,
        EXPORT_DATA: False,
        MANAGE_DEVICES: False,
        MANAGE_RULES: False,
        MANAGE_MODELS: False,
        VIEW_AUDIT: False,
        MANAGE_ASSIGNMENTS: False,
        MANAGE_DATA: False,
        MANAGE_WORLD: False,
        QUERY_ASSISTANT: True,
        RAISE_ANDON: False,
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


def action_for_request(method, path):
    """按 HTTP 方法 + 路径把请求映射到 RBAC 动作（无匹配返回 None）。

    EDGE-001 收敛（2026-08-17 审计整改）：production 下全部 ``/api/*`` 与 ``/metrics``
    GET 路径必须映射 VIEW_* 动作——server.do_GET 对未映射的 /api/* GET 默认拒绝
    （fail-closed 401）；development/simulation 不受影响（宽松演示语义）。

    GET 映射：
    - 审计查询/安全策略 → view_audit（data_analyst/viewer 不可见）；
    - 原始数据导出 → export_data；
    - 人员档案（PII） → view_personnel（viewer 不可见）；
    - 遥测/设备/推理/模型/规则/状态/资源等机器态读 → view_telemetry；
    - 事件/任务/调度/派工/世界态等业务事实读 → view_events。
    认证后的读语义按矩阵放行（监督平台读语义与云侧一致，但不再匿名放行）。

    写映射：
    - 事件处置/评论（含 legacy /api/event/status） → handle_events；
    - 任务/调度/派工写路径（含 /api/scheduler/* 求解） → manage_assignments
      （operator 无权，防越权派工）；
    - 模型/规则写路径 → manage_models / manage_rules；
    - /api/telemetry/export（GET/POST 导出） → export_data；
    - /api/reset（破坏性数据重置） → manage_data（仅 admin）；
    - /api/world/*（写世界状态/事件/预测） → manage_world（仅 admin）；
    - /api/query、/api/scenario/evaluate、/api/vision/understand → query_assistant；
    - /api/andon/raise → raise_andon（现场开灯）；
    - /api/exo/bind|unbind → manage_devices（外骨骼绑定归属另见路由层校验）。

    2026-08-19 审计 P1：production 下 server 对未映射的 /api/* 写路径
    fail-closed 默认拒绝（与 GET 读守卫同款语义），未映射不再隐式放行。
    """
    m = (method or "").upper()
    p = path or ""
    if m == "GET":
        return _action_for_get(p)
    if m in ("POST", "PATCH", "PUT", "DELETE"):
        return _action_for_write(p)
    return None


def _action_for_get(p):
    """GET 路径 → 动作（含 /metrics；未映射返回 None，由 server 层 fail-closed）。"""
    if p == "/metrics":  # Prometheus 暴露面（非 /api 前缀）
        return VIEW_TELEMETRY
    if not p.startswith("/api/"):
        return None  # 静态资源/SPA 不经 RBAC
    if p.startswith("/api/audit"):
        return VIEW_AUDIT
    if p == "/api/security/policy":
        return VIEW_AUDIT  # 安全配置画像仅限可审计角色
    if p.startswith("/api/telemetry/export"):
        return EXPORT_DATA
    if p == "/api/person/profile" or p == "/api/people":
        return VIEW_PERSONNEL
    if p.startswith("/api/events") or p == "/api/event":
        return VIEW_EVENTS
    if (
        p.startswith("/api/telemetry")
        or p.startswith("/api/devices")
        or p.startswith("/api/inference")
        or p.startswith("/api/models")
        or p.startswith("/api/rules")
        or p == "/api/status"
        or p.startswith("/api/scheduler/")
        or p.startswith("/api/resources/")
        or p.startswith("/api/demo/")
        or p == "/api/me"
    ):
        return VIEW_TELEMETRY
    if p.startswith("/api/actuators"):
        # NO-59b：执行机构状态属机器态读（与设备/遥测同域）。
        return VIEW_TELEMETRY
    if (
        p.startswith("/api/tasks")
        or p.startswith("/api/scheduling")
        or p.startswith("/api/assignments")
        or p.startswith("/api/world/")
        or p.startswith("/api/command-map/")
    ):
        return VIEW_EVENTS
    return None


def _action_for_write(p):
    """写路径 → 动作（未映射返回 None；production 下 server 对未映射 /api/*
    写路径 fail-closed 拒绝——2026-08-19 审计 P1：原语义为 action=None 静默
    放行（fail-open），如 /api/scheduler/v2/solve 触发 CP-SAT 求解却绕过 RBAC）。"""
    if p == "/api/event/status":  # EDGE-008：legacy 端点显式映射，消除 RBAC 绕过
        return HANDLE_EVENTS
    if p.startswith("/api/events/"):
        return HANDLE_EVENTS
    if (
        p.startswith("/api/tasks")
        or p.startswith("/api/scheduling")
        or p.startswith("/api/assignments")
        or p.startswith("/api/scheduler/")  # P1：v2/solve 求解写路径属派工域
    ):
        return MANAGE_ASSIGNMENTS
    if p.startswith("/api/models"):
        return MANAGE_MODELS
    if p.startswith("/api/rules"):
        return MANAGE_RULES
    if p == "/api/telemetry/export":  # P1：POST 导出与 GET 同域（export_data）
        return EXPORT_DATA
    if p == "/api/reset":  # EDGE-012：破坏性数据操作仅 admin
        return MANAGE_DATA
    if p.startswith("/api/world/"):  # EDGE-038：写世界模型仅 admin
        return MANAGE_WORLD
    if p == "/api/query" or p.startswith("/api/scenario/") or p == "/api/vision/understand":
        return QUERY_ASSISTANT  # EDGE-048：助手面收敛为显式动作
    if p.startswith("/api/andon/"):  # EDGE-039：安灯开灯收敛为显式动作
        return RAISE_ANDON
    if p.startswith("/api/exo/"):  # 绑定/解绑属设备管理域
        return MANAGE_DEVICES
    if p.startswith("/api/actuators/"):
        # NO-59b：执行机构命令面 = 设备管理域（RBAC 第一道闸）；
        # 高危命令（让设备动起来/解除安全停机）在适配器层**再要求平台授权号**（第二道闸）；
        # `stop` 是安全动作，只需要 RBAC，不被授权链卡住。
        return MANAGE_DEVICES
    return None


def check_export_role(role, allowed_roles) -> bool:
    """校验角色是否在导出允许名单内。

    ``allowed_roles`` 为 ``Settings.export_allowed_roles``（角色值字符串的可迭代对象）。
    """
    role_value = _role_value(role)
    return role_value in tuple(allowed_roles)
