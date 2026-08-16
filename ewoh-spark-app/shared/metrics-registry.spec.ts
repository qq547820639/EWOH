/* MetricsRegistry 契约测试（ADR-023 / NO-10b，§19 指标腿）。
 *
 * 覆盖：注册表封闭（未知指标/类型失配/未知标签拒绝）、counter 非负、
 * histogram le 标签强制、合法 counter/gauge/histogram 通过。
 */
/// <reference types="jest" />
import { validateMetricSample, METRIC_REGISTRY } from './metrics-registry';

describe('validateMetricSample（ADR-023 指标注册表）', () => {
  it('合法 counter（agent 指标，注册标签）通过', () => {
    expect(
      validateMetricSample({
        metricName: 'agent_command_executed_total',
        metricType: 'counter',
        value: 3,
        labels: { role: 'Knowledge', command: 'register_knowledge' },
      }),
    ).toEqual([]);
  });

  it('合法 gauge 通过', () => {
    expect(
      validateMetricSample({ metricName: 'scheduler_feasible_ratio', metricType: 'gauge', value: 1, labels: {} }),
    ).toEqual([]);
  });

  it('合法 histogram（带 le）通过；缺 le 拒绝', () => {
    expect(
      validateMetricSample({ metricName: 'scheduler_run_duration_ms', metricType: 'histogram', value: 4, labels: { le: '500' } }),
    ).toEqual([]);
    expect(
      validateMetricSample({ metricName: 'scheduler_run_duration_ms', metricType: 'histogram', value: 4, labels: {} })[0],
    ).toBe('histogram_le_required');
  });

  it('未注册指标 → unknown_metric（§33 unknown 不当 normal）', () => {
    expect(
      validateMetricSample({ metricName: 'teleport_gauge', metricType: 'gauge', value: 1, labels: {} })[0],
    ).toBe('unknown_metric');
  });

  it('类型失配 → metric_type_mismatch', () => {
    expect(
      validateMetricSample({
        metricName: 'agent_command_executed_total',
        metricType: 'gauge',
        value: 3,
        labels: {},
      })[0],
    ).toBe('metric_type_mismatch');
  });

  it('未知标签键 → unknown_label', () => {
    expect(
      validateMetricSample({
        metricName: 'agent_command_executed_total',
        metricType: 'counter',
        value: 3,
        labels: { teleport_label: 'x' },
      })[0],
    ).toBe('unknown_label');
  });

  it('负数 counter 拒绝（bad_value）', () => {
    expect(
      validateMetricSample({ metricName: 'agent_command_executed_total', metricType: 'counter', value: -1, labels: {} })[0],
    ).toBe('bad_value');
  });

  it('注册表覆盖三个面（http/scheduler/agent/connector 家族齐全）', () => {
    const names = METRIC_REGISTRY.map((e) => e.name);
    expect(names).toContain('http_requests_total');
    expect(names).toContain('scheduler_run_total');
    expect(names).toContain('agent_command_executed_total');
    expect(names).toContain('connector_telemetry_samples_total');
  });
});
