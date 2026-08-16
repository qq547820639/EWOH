"""Canonical Industrial Metrics Registry 契约（ADR-023 / NO-10b，§19 指标腿）。

权威契约：contracts/observability/metrics-registry.schema.json +
metrics-registry.test-vectors.json。锁定注册表必须与 schema 一致，由
scripts/audit-domain-contracts.js observability 域门禁强制。

语义（§19 + ADR-023）：
- 跨模块指标命名契约：metricName 必须命中封闭注册表（未注册 = violation
  显式列出，绝不静默并入正常——§33）；
- metricType 必须与注册表声明一致；labels 键必须命中该指标 labelKeys；
- counter 非负有限数值；histogram 样本必须带 le 标签。

零第三方依赖（pyproject dependencies=[]）。
"""

from __future__ import annotations

import math
from typing import Any

METRIC_TYPES: tuple[str, ...] = ("counter", "gauge", "histogram")
METRIC_LABEL_KEYS: tuple[str, ...] = (
    "method", "route", "status", "result", "solver_version", "feasible",
    "le", "role", "command", "outcome", "connector_id", "connector_type",
    "table", "edge_id",
)

# name -> (type, labelKeys)
METRIC_REGISTRY: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("http_requests_total", "counter", ("method", "route", "status")),
    ("http_active_requests", "gauge", ()),
    ("db_ready_checks_total", "counter", ("result",)),
    ("scheduler_run_total", "counter", ("solver_version", "status", "feasible")),
    ("scheduler_run_duration_ms", "histogram", ("le",)),
    ("scheduler_feasible_ratio", "gauge", ()),
    ("agent_manifest_registered_total", "counter", ("role",)),
    ("agent_command_proposed_total", "counter", ("role", "command")),
    ("agent_command_executed_total", "counter", ("role", "command")),
    ("agent_command_rejected_total", "counter", ("role", "command")),
    ("agent_command_delegated_total", "counter", ("role", "command")),
    ("agent_approval_resolved_total", "counter", ("outcome",)),
    ("connector_telemetry_samples_total", "counter", ("connector_id", "connector_type")),
    ("connector_active_total", "gauge", ("connector_id", "connector_type")),
    ("connector_error_total", "counter", ("connector_id", "connector_type")),
    # ── 边缘 ewoh_* 家族（ADR-028：Edge→Cloud 指标上行命名收敛同一注册表）──
    ("ewoh_uptime_seconds", "gauge", ("edge_id",)),
    ("ewoh_db_count", "gauge", ("table", "edge_id")),
    ("ewoh_device_online_count", "gauge", ("edge_id",)),
    ("ewoh_device_offline_count", "gauge", ("edge_id",)),
    ("ewoh_device_avg_packet_loss_pct", "gauge", ("edge_id",)),
    ("ewoh_device_low_battery_count", "gauge", ("edge_id",)),
    ("ewoh_inference_count_total", "counter", ("edge_id",)),
    ("ewoh_inference_p50_ms", "gauge", ("edge_id",)),
    ("ewoh_inference_p95_ms", "gauge", ("edge_id",)),
    ("ewoh_inference_unknown_count_total", "counter", ("edge_id",)),
    ("ewoh_inference_error_count_total", "counter", ("edge_id",)),
    ("ewoh_event_open_count", "gauge", ("edge_id",)),
    ("ewoh_event_open_total", "counter", ("edge_id",)),
    ("ewoh_event_avg_close_hours", "gauge", ("edge_id",)),
    ("ewoh_assignment_recommendation_count_total", "counter", ("edge_id",)),
    ("ewoh_assignment_confirmed_count_total", "counter", ("edge_id",)),
    ("ewoh_assignment_adoption_rate", "gauge", ("edge_id",)),
    ("ewoh_event_bus_handler_errors_total", "counter", ("edge_id",)),
)

METRIC_NAMES: tuple[str, ...] = tuple(entry[0] for entry in METRIC_REGISTRY)
_BY_NAME: dict[str, tuple[str, tuple[str, ...]]] = {
    entry[0]: (entry[1], entry[2]) for entry in METRIC_REGISTRY
}

_REQUIRED_FIELDS = ("metricName", "metricType", "value", "labels")


def validate_metric_sample(record: Any) -> list[str]:
    """校验指标样本；返回错误码列表（空 = 合法）。fail-closed。"""
    if not isinstance(record, dict):
        return ["record_must_be_object"]
    for field in _REQUIRED_FIELDS:
        if field not in record:
            return [f"missing_field:{field}"]
    name = record["metricName"]
    if not isinstance(name, str) or name not in _BY_NAME:
        return ["unknown_metric"]
    expected_type, expected_labels = _BY_NAME[name]
    if record["metricType"] != expected_type:
        return ["metric_type_mismatch"]
    value = record["value"]
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        return ["bad_value"]
    if expected_type == "counter" and value < 0:
        return ["bad_value"]
    labels = record["labels"]
    if not isinstance(labels, dict):
        return ["bad_labels"]
    for key in labels:
        if key not in expected_labels:
            return ["unknown_label"]
    if expected_type == "histogram" and "le" not in labels:
        return ["histogram_le_required"]
    return []
