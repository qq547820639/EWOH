"""Canonical Agent Task 契约（ADR-017 / NO-06e，intelligence-l5-agentic 立项）。

权威契约：contracts/agent-task/agent-task.schema.json + test-vectors.json。
锁定注册表必须与 schema 一致，由 scripts/audit-domain-contracts.js agent_task
域门禁强制（含 agentRoleRegistry 与 agent-manifest 契约的交叉核对）。

语义（ADR-017）：
- AgentTask 是 Command 之上的一层编排；执行仍走 AgentRuntime.executeCommand
  （ADR-016 边界不变），编排引擎绝不绕过 §2 安全边界；
- taskId 规范身份（ADR-006，task:value）；assignedRole ∈ 15 类注册表；
- kind ∈ {analysis, suggestion, execution}；priority/status 封闭注册表；
- dependencies 规范身份数组 + 禁止自引用（DAG 机器规则）；
- dueTime 可选 ISO 且不得早于 createdAt（时间语义与 ADR-009 同源）；
- budget 下界；auditTrail 必须 true（与 ADR-016 同规则）。

零第三方依赖（pyproject dependencies=[]）。
"""

from __future__ import annotations

from typing import Any

from .identity import is_canonical_identity

TASK_KINDS: tuple[str, ...] = ("analysis", "suggestion", "execution")
PRIORITIES: tuple[str, ...] = ("low", "medium", "high", "critical")
STATUSES: tuple[str, ...] = (
    "created", "dispatched", "in_progress", "completed", "failed", "cancelled",
)

_REQUIRED_FIELDS = (
    "taskId", "name", "version", "kind", "assignedRole", "dependencies",
    "inputContract", "outputContract", "priority", "createdAt", "budget",
    "status", "auditTrail",
)


def _parse_iso(value: Any):
    from .envelope import parse_ts

    return parse_ts(value) if isinstance(value, str) else None


def validate_agent_task(record: Any, agent_roles: tuple[str, ...]) -> list[str]:
    """校验 AgentTask；返回错误码列表（空 = 合法）。fail-closed。

    agent_roles 由调用方注入（与 agent-manifest 契约同源注册表），
    保证单一事实源；门禁独立仲裁时以 schema 注册表注入。
    """
    if not isinstance(record, dict):
        return ["record_must_be_object"]
    for field in _REQUIRED_FIELDS:
        if field not in record:
            return [f"missing_field:{field}"]
    if not isinstance(record["taskId"], str) or not is_canonical_identity(record["taskId"]):
        return ["bad_task_id"]
    if not isinstance(record["name"], str) or not record["name"]:
        return ["bad_name"]
    version = record["version"]
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        return ["bad_version"]
    if record["kind"] not in TASK_KINDS:
        return ["unknown_kind"]
    if record["assignedRole"] not in agent_roles:
        return ["unknown_role"]
    assignee = record.get("assigneeAgentId")
    if assignee is not None and (
        not isinstance(assignee, str) or not is_canonical_identity(assignee)
    ):
        return ["bad_assignee"]
    dependencies = record["dependencies"]
    if not isinstance(dependencies, list) or any(
        not isinstance(d, str) or not is_canonical_identity(d) for d in dependencies
    ):
        return ["bad_dependency"]
    if record["taskId"] in dependencies:
        return ["self_dependency"]
    for key in ("inputContract", "outputContract"):
        contract = record[key]
        if not isinstance(contract, dict) or not isinstance(contract.get("schemaRef"), str):
            return ["bad_contract"]
    if record["priority"] not in PRIORITIES:
        return ["bad_priority"]
    created_ms = _parse_iso(record["createdAt"])
    if created_ms is None:
        return ["bad_time"]
    due_time = record.get("dueTime")
    if due_time is not None:
        due_ms = _parse_iso(due_time)
        if due_ms is None or due_ms < created_ms:
            return ["bad_time"]
    budget = record["budget"]
    if not isinstance(budget, dict):
        return ["bad_budget"]
    for key in ("maxSteps", "maxTokens", "maxDurationSec"):
        value = budget.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            return ["bad_budget"]
    if record["status"] not in STATUSES:
        return ["bad_status"]
    if record["auditTrail"] is not True:
        return ["audit_required"]
    return []


def agent_task_transition_allowed(current: str, target: str) -> bool:
    """状态转移判定（与 contracts/state-machines/agent-task.yaml 一致）。"""
    allowed = {
        "created": {"dispatched", "cancelled"},
        "dispatched": {"in_progress", "cancelled"},
        "in_progress": {"completed", "failed", "cancelled"},
    }
    return current in allowed and target in allowed[current]
