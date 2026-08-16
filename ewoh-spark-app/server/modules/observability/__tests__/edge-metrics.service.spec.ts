/* EdgeMetricsService 契约行为测试（ADR-028 / NO-12d，§19 指标腿 Edge→Cloud 上行）。
 *
 * 覆盖：ingest 契约 fail-closed（未注册名/类型失配/未知标签/负 counter =
 * violation 显式列出，有效样本正常并入）、per-org 隔离（他租户样本不可见）、
 * latest-wins upsert、org 缺失显式拒绝、上行健康面（connector_* 家族样本
 * 计数/active/error）、TTL 过期移除。
 */
/// <reference types="jest" />
import { EdgeMetricsService } from '../edge-metrics.service';

const EDGE_SAMPLE = {
  metricName: 'ewoh_uptime_seconds',
  metricType: 'gauge',
  value: 12.3,
  labels: { edge_id: 'edge-a' },
};

describe('EdgeMetricsService（NO-12d 指标上行接收面）', () => {
  it('ingest 契约 fail-closed：未注册名 → violation 显式且不并入', () => {
    const svc = new EdgeMetricsService();
    const result = svc.ingest('org-a', [
      { ...EDGE_SAMPLE, metricName: 'gizmo_metric' },
    ]);
    expect(result.accepted).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.violations[0]).toContain('unknown_metric');
    expect(svc.getSamples('org-a')).toHaveLength(0);
  });

  it('ingest 有效样本并入 + 未知标签/负 counter 违规显式', () => {
    const svc = new EdgeMetricsService();
    const result = svc.ingest('org-a', [
      EDGE_SAMPLE,
      { ...EDGE_SAMPLE, metricName: 'ewoh_inference_count_total', metricType: 'counter', value: -1 },
      { ...EDGE_SAMPLE, labels: { edge_id: 'edge-a', weird: 'x' } },
    ]);
    expect(result.accepted).toBe(1);
    expect(result.rejected).toBe(2);
    expect(svc.getSamples('org-a')).toHaveLength(1);
  });

  it('org 缺失显式拒绝（RLS 语义：绝不写无租户样本）', () => {
    const svc = new EdgeMetricsService();
    const result = svc.ingest('', [EDGE_SAMPLE]);
    expect(result.accepted).toBe(0);
    expect(result.violations[0]).toBe('org:missing_org_context');
  });

  it('per-org 隔离：他租户样本不可见；缺省 orgId = 全量视图', () => {
    const svc = new EdgeMetricsService();
    svc.ingest('org-a', [EDGE_SAMPLE]);
    svc.ingest('org-b', [{ ...EDGE_SAMPLE, metricName: 'ewoh_device_online_count' }]);
    expect(svc.getSamples('org-a')).toHaveLength(1);
    expect(svc.getSamples('org-b')).toHaveLength(1);
    expect(svc.getSamples()).toHaveLength(2);
  });

  it('latest-wins：同 (metricName,labels) upsert 不重复', () => {
    const svc = new EdgeMetricsService();
    svc.ingest('org-a', [EDGE_SAMPLE]);
    svc.ingest('org-a', [{ ...EDGE_SAMPLE, value: 99.9 }]);
    const samples = svc.getSamples('org-a');
    expect(samples).toHaveLength(1);
    expect(samples[0]?.value).toBe(99.9);
  });

  it('上行健康面：connector_* 家族样本（samples_total/error_total/active）', () => {
    const svc = new EdgeMetricsService();
    svc.ingest('org-a', [EDGE_SAMPLE, { ...EDGE_SAMPLE, metricName: 'gizmo' }]);
    const connector = svc.getConnectorSamples();
    const names = connector.map((s) => s.metricName);
    expect(names).toContain('connector_telemetry_samples_total');
    expect(names).toContain('connector_error_total');
    const active = connector.find((s) => s.metricName === 'connector_active_total');
    expect(active?.value).toBe(1);
    const samplesTotal = connector.find((s) => s.metricName === 'connector_telemetry_samples_total');
    expect(samplesTotal?.value).toBe(1);
  });

  it('TTL 过期：超期样本不再导出（周期快照语义）', () => {
    const svc = new EdgeMetricsService();
    svc.ingest('org-a', [EDGE_SAMPLE]);
    // 直接操纵内部时间不可行——用第二笔 ingest 触发 sweep 前先篡改 receivedAt
    const store = (svc as unknown as { byOrg: Map<string, Map<string, { receivedAt: number }>> }).byOrg;
    for (const entry of store.get('org-a')?.values() ?? []) {
      entry.receivedAt = Date.now() - 6 * 60 * 1000;
    }
    svc.ingest('org-a', [{ ...EDGE_SAMPLE, metricName: 'ewoh_device_online_count' }]);
    const samples = svc.getSamples('org-a');
    expect(samples).toHaveLength(1);
    expect(samples[0]?.metricName).toBe('ewoh_device_online_count');
  });
});
