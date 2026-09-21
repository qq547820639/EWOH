"""Canonical Agent Manifest 契约（ADR-016 / Phase 9 立项，NO-06）。

权威契约：contracts/agent/agent-manifest.schema.json + test-vectors.json。
锁定注册表必须与 schema 一致，由 scripts/audit-domain-contracts.js agent 域
门禁强制。

语义（§11 + ADR-016）：
- Agent 不得绕过系统架构：通过正式 Tools 行动、写动作必须转换为结构化 Command；
- agentId 规范身份（ADR-006，agent:value）；role ∈ 15 类封闭注册表；
- readScope/writeScope ∈ scopeTokenRegistry；writeScope.commands ⊆ commandRegistry；
- Autonomous Level 显式阶梯 L0..L3（L4 永不允许）；L2/L3 必须显式非空
  approvalRequiredFor；riskLevel=critical 仅 L0/L1；Safety 角色仅 L0/L1 且
  写范围为空（supervisory 定位，§2 安全边界）；
- auditTrail 必须 true；budget/timeout 下界；fallback.onFailure ∈
  {fail, retry, delegateHuman, safeIdle}（失败显式语义）。

零第三方依赖（pyproject dependencies=[]）。
"""

from __future__ import annotations

from typing import Any

from .identity import is_canonical_identity

AGENT_ROLES: tuple[str, ...] = (
    "FactorySupervisor", "Logistics", "Production", "Maintenance", "Quality",
    "Safety", "Scheduling", "Material", "Energy", "WorkerSupport",
    "Exoskeleton", "Incident", "Knowledge", "Simulation", "Operations",
)
SCOPE_TOKENS: frozenset = frozenset(
    {
        "worldSnapshot", "worldReplay", "personnelData", "equipmentData",
        "materialData", "schedulingData", "maintenanceData", "qualityData",
        "incidentData", "energyData", "simulationData", "knowledgeData",
    }
)
COMMANDS: frozenset = frozenset(
    {
        "propose_plan", "reserve_resource", "dispatch_task", "create_work_order",
        "notify_personnel", "request_approval", "run_simulation", "record_evidence",
        "register_knowledge",
    }
)
RISK_LEVELS: tuple[str, ...] = ("low", "medium", "high", "critical")
AUTONOMOUS_LEVELS: tuple[str, ...] = ("L0", "L1", "L2", "L3")
FALLBACK_STRATEGIES: frozenset = frozenset({"fail", "retry", "delegateHuman", "safeIdle"})
# L3 只允许低风险、可审计或纯建议/仿真类命令（ADR-016 §Autonomous Level）。
L3_SAFE_COMMANDS: frozenset = frozenset(
    {"propose_plan", "record_evidence", "request_approval", "run_simulation"}
)

_REQUIRED_FIELDS = (
    "agentId", "name", "version", "role", "purpose", "allowedTools", "readScope",
    "writeScope", "approvalRequirement", "riskLevel", "inputContract",
    "outputContract", "auditTrail", "budget", "timeoutSec", "fallback",
)


def _bad_list(value: Any, validator) -> bool:
    return not isinstance(value, list) or any(not validator(x) for x in value)


def validate_agent_manifest(record: Any) -> list[str]:
    """校验 Agent Manifest；返回错误码列表（空 = 合法）。fail-closed。"""
    if not isinstance(record, dict):
        return ["record_must_be_object"]
    for field in _REQUIRED_FIELDS:
        if field not in record:
            return [f"missing_field:{field}"]
    if not isinstance(record["agentId"], str) or not is_canonical_identity(record["agentId"]):
        return ["bad_agent_id"]
    if record["role"] not in AGENT_ROLES:
        return ["unknown_role"]
    if not isinstance(record["name"], str) or not record["name"]:
        return ["bad_name"]
    version = record["version"]
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        return ["bad_version"]
    if not isinstance(record["purpose"], str) or not record["purpose"].strip():
        return ["empty_purpose"]
    tools = record["allowedTools"]
    if _bad_list(tools, lambda t: isinstance(t, str) and is_canonical_identity(t)):
        return ["bad_tool"]
    read_scope = record["readScope"]
    if _bad_list(read_scope, lambda s: isinstance(s, str)):
        return ["bad_scope"]
    for token in read_scope:
        if token not in SCOPE_TOKENS:
            return ["unknown_scope_token"]
    write_scope = record["writeScope"]
    if not isinstance(write_scope, dict):
        return ["bad_write_scope"]
    write_tokens = write_scope.get("tokens", [])
    if _bad_list(write_tokens, lambda s: isinstance(s, str)):
        return ["bad_scope"]
    for token in write_tokens:
        if token not in SCOPE_TOKENS:
            return ["unknown_scope_token"]
    write_commands = write_scope.get("commands", [])
    if _bad_list(write_commands, lambda c: isinstance(c, str)):
        return ["bad_command"]
    for command in write_commands:
        if command not in COMMANDS:
            return ["unknown_command"]
    approval = record["approvalRequirement"]
    if not isinstance(approval, dict):
        return ["bad_approval"]
    level = approval.get("autonomousLevel")
    if level not in AUTONOMOUS_LEVELS:
        return ["unknown_autonomous_level"]
    required = approval.get("approvalRequiredFor")
    if _bad_list(required, lambda c: isinstance(c, str)):
        return ["bad_approval"]
    for command in required:
        if command not in COMMANDS:
            return ["unknown_command"]
    if level in ("L2", "L3") and len(required) == 0:
        return ["approval_required"]
    if record["riskLevel"] not in RISK_LEVELS:
        return ["unknown_risk_level"]
    # riskLevel=critical 仅 L0/L1（人审强度与自治等级挂钩）
    if record["riskLevel"] == "critical" and level in ("L2", "L3"):
        return ["level_risk_conflict"]
    # Safety 角色：仅 L0/L1 且写范围为空（supervisory，§2）
    if record["role"] == "Safety":
        if level in ("L2", "L3"):
            return ["safety_autonomy_forbidden"]
        if write_tokens or write_commands:
            return ["safety_role_write_forbidden"]
    # L3 仅限低风险、可逆/可审计动作；高风险写命令必须留在 L2 审批或 L1。
    if level == "L3":
        if record["riskLevel"] != "low":
            return ["l3_risk_forbidden"]
        if any(command not in L3_SAFE_COMMANDS for command in write_commands):
            return ["l3_command_forbidden"]
        if any(token != "simulationData" for token in write_tokens):
            return ["l3_scope_forbidden"]
    for key in ("inputContract", "outputContract"):
        contract = record[key]
        # R2-SHR-006：schemaRef 空串拒绝（对齐 TS agent-manifest.ts ref === '' 拒绝）。
        if (
            not isinstance(contract, dict)
            or not isinstance(contract.get("schemaRef"), str)
            or contract["schemaRef"] == ""
        ):
            return ["bad_contract"]
    if record["auditTrail"] is not True:
        return ["audit_required"]
    budget = record["budget"]
    if not isinstance(budget, dict):
        return ["bad_budget"]
    for key in ("maxSteps", "maxTokens", "maxDurationSec"):
        value = budget.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            return ["bad_budget"]
    timeout_sec = record["timeoutSec"]
    if not isinstance(timeout_sec, int) or isinstance(timeout_sec, bool) or timeout_sec < 1:
        return ["bad_timeout"]
    fallback = record["fallback"]
    if not isinstance(fallback, dict) or fallback.get("onFailure") not in FALLBACK_STRATEGIES:
        return ["unknown_fallback"]
    fallback_agent = fallback.get("fallbackAgentId")
    if fallback_agent is not None and (
        not isinstance(fallback_agent, str) or not is_canonical_identity(fallback_agent)
    ):
        return ["bad_fallback_agent"]
    return []
