/* 前后端共享契约 - Canonical Industrial Metrics Registry（ADR-023 / NO-10b）。
 *
 * 权威契约：contracts/observability/metrics-registry.schema.json +
 * metrics-registry.test-vectors.json。
 * 语义与 src/edge_platform/contracts/metrics_registry.py 逐项一致（共享向量约束）。
 */

export const METRIC_TYPES = ['counter', 'gauge', 'histogram'] as const;
export const METRIC_LABEL_KEYS = [
  'method', 'route', 'status', 'result', 'solver_version', 'feasible',
  'le', 'role', 'command', 'outcome', 'connector_id', 'connector_type',
  'table', 'edge_id',
] as const;

export interface MetricRegistryEntry {
  name: string;
  type: (typeof METRIC_TYPES)[number];
  labelKeys: readonly string[];
}

export const METRIC_REGISTRY: readonly MetricRegistryEntry[] = [
  { name: 'http_requests_total', type: 'counter', labelKeys: ['method', 'route', 'status'] },
  { name: 'http_active_requests', type: 'gauge', labelKeys: [] },
  { name: 'db_ready_checks_total', type: 'counter', labelKeys: ['result'] },
  { name: 'scheduler_run_total', type: 'counter', labelKeys: ['solver_version', 'status', 'feasible'] },
  { name: 'scheduler_run_duration_ms', type: 'histogram', labelKeys: ['le'] },
  { name: 'scheduler_feasible_ratio', type: 'gauge', labelKeys: [] },
  { name: 'agent_manifest_registered_total', type: 'counter', labelKeys: ['role'] },
  { name: 'agent_command_proposed_total', type: 'counter', labelKeys: ['role', 'command'] },
  { name: 'agent_command_executed_total', type: 'counter', labelKeys: ['role', 'command'] },
  { name: 'agent_command_rejected_total', type: 'counter', labelKeys: ['role', 'command'] },
  { name: 'agent_command_delegated_total', type: 'counter', labelKeys: ['role', 'command'] },
  { name: 'agent_approval_resolved_total', type: 'counter', labelKeys: ['outcome'] },
  { name: 'connector_telemetry_samples_total', type: 'counter', labelKeys: ['connector_id', 'connector_type'] },
  { name: 'connector_active_total', type: 'gauge', labelKeys: ['connector_id', 'connector_type'] },
  { name: 'connector_error_total', type: 'counter', labelKeys: ['connector_id', 'connector_type'] },
  // ── 边缘 ewoh_* 家族（ADR-028：边缘 Prometheus 事实源成为规范家族，
  //    Edge→Cloud 指标上行命名收敛同一注册表；edge_id 为上行传输标签）──
  { name: 'ewoh_uptime_seconds', type: 'gauge', labelKeys: ['edge_id'] },
  { name: 'ewoh_db_count', type: 'gauge', labelKeys: ['table', 'edge_id'] },
  { name: 'ewoh_device_online_count', type: 'gauge', labelKeys: ['edge_id'] },
  { name: 'ewoh_device_offline_count', type: 'gauge', labelKeys: ['edge_id'] },
  { name: 'ewoh_device_avg_packet_loss_pct', type: 'gauge', labelKeys: ['edge_id'] },
  { name: 'ewoh_device_low_battery_count', type: 'gauge', labelKeys: ['edge_id'] },
  { name: 'ewoh_inference_count_total', type: 'counter', labelKeys: ['edge_id'] },
  { name: 'ewoh_inference_p50_ms', type: 'gauge', labelKeys: ['edge_id'] },
  { name: 'ewoh_inference_p95_ms', type: 'gauge', labelKeys: ['edge_id'] },
  { name: 'ewoh_inference_unknown_count_total', type: 'counter', labelKeys: ['edge_id'] },
  { name: 'ewoh_inference_error_count_total', type: 'counter', labelKeys: ['edge_id'] },
  { name: 'ewoh_event_open_count', type: 'gauge', labelKeys: ['edge_id'] },
  { name: 'ewoh_event_open_total', type: 'counter', labelKeys: ['edge_id'] },
  { name: 'ewoh_event_avg_close_hours', type: 'gauge', labelKeys: ['edge_id'] },
  { name: 'ewoh_assignment_recommendation_count_total', type: 'counter', labelKeys: ['edge_id'] },
  { name: 'ewoh_assignment_confirmed_count_total', type: 'counter', labelKeys: ['edge_id'] },
  { name: 'ewoh_assignment_adoption_rate', type: 'gauge', labelKeys: ['edge_id'] },
  { name: 'ewoh_event_bus_handler_errors_total', type: 'counter', labelKeys: ['edge_id'] },
] as const;

export const METRIC_NAMES = METRIC_REGISTRY.map((entry) => entry.name);

const BY_NAME: ReadonlyMap<string, MetricRegistryEntry> = new Map(
  METRIC_REGISTRY.map((entry) => [entry.name, entry]),
);

const REQUIRED_FIELDS = ['metricName', 'metricType', 'value', 'labels'] as const;

/** 校验指标样本；返回错误码列表（空 = 合法）。fail-closed。 */
export function validateMetricSample(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  const name = String(r.metricName);
  const entry = BY_NAME.get(name);
  if (!entry) return ['unknown_metric'];
  if (r.metricType !== entry.type) return ['metric_type_mismatch'];
  const value = r.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return ['bad_value'];
  if (entry.type === 'counter' && value < 0) return ['bad_value'];
  const labels = r.labels;
  if (typeof labels !== 'object' || labels === null || Array.isArray(labels)) {
    return ['bad_labels'];
  }
  for (const key of Object.keys(labels)) {
    if (!(entry.labelKeys as readonly string[]).includes(key)) return ['unknown_label'];
  }
  if (entry.type === 'histogram' && !('le' in (labels as Record<string, unknown>))) {
    return ['histogram_le_required'];
  }
  return [];
}
