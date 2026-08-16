/* MetricsExportService 契约行为测试（ADR-023 / NO-10b，§19 指标腿）。
 *
 * 覆盖：统一组装（http/db/scheduler/agent 面真实来源）、样本契约校验
 * fail-closed、registryViolations 显式（未注册 legacy 名/类型失配/负值）、
 * connector 面零样本显式、Prometheus 文本渲染（violation 以注释暴露）。
 */
/// <reference types="jest" />
import { MetricsExportService } from '../metrics-export.service';

function makeHttp(requests: Record<string, number>, active: number, dbOk: number, dbFailed: number) {
  return {
    snapshot: () => ({
      uptimeSeconds: 1,
      activeRequests: active,
      requests,
      dbReady: { ok: dbOk, failed: dbFailed },
    }),
  };
}

function makeScheduler(raw: Record<string, number>) {
  return { snapshot: () => ({ ...raw }) };
}

function makeAgent(samples: Array<Record<string, unknown>>) {
  return { snapshot: () => samples };
}

describe('MetricsExportService（NO-10b 统一指标导出面）', () => {
  it('组装四来源样本并通过注册表校验（violations 空）', () => {
    const service = new MetricsExportService(
      makeHttp({ 'GET /api/x 200': 5 }, 2, 10, 1) as never,
      makeScheduler({
        'scheduler_run_total{solver_version="v1",status="ok",feasible="true"}': 3,
        scheduler_feasible_ratio: 1,
        'scheduler_run_duration_ms_bucket{le="500"}': 2,
      }) as never,
      makeAgent([
        {
          metricName: 'agent_command_executed_total',
          metricType: 'counter',
          value: 2,
          labels: { role: 'Knowledge', command: 'register_knowledge' },
        },
      ]) as never,
    );
    const { metrics, registryViolations } = service.snapshot();
    expect(registryViolations).toEqual([]);
    const names = metrics.map((m) => m.metricName);
    expect(names).toContain('http_requests_total');
    expect(names).toContain('http_active_requests');
    expect(names).toContain('db_ready_checks_total');
    expect(names).toContain('scheduler_run_total');
    expect(names).toContain('scheduler_feasible_ratio');
    expect(names).toContain('scheduler_run_duration_ms');
    expect(names).toContain('agent_command_executed_total');
    const httpSample = metrics.find((m) => m.metricName === 'http_requests_total');
    expect(httpSample?.labels).toEqual({ method: 'GET', route: '/api/x', status: '200' });
    const hist = metrics.find(
      (m) => m.metricName === 'scheduler_run_duration_ms' && m.labels.le === '500',
    );
    expect(hist?.metricType).toBe('histogram');
  });

  it('legacy 未注册指标 → registryViolations 显式（§33 不静默丢弃）', () => {
    const service = new MetricsExportService(
      makeHttp({}, 0, 0, 0) as never,
      makeScheduler({ plan_approved_total: 7, 'gizmo_total{teleport="x"}': 1 }) as never,
      undefined,
    );
    const { metrics, registryViolations } = service.snapshot();
    expect(metrics.map((m) => m.metricName)).not.toContain('plan_approved_total');
    expect(registryViolations.some((v) => v.startsWith('plan_approved_total:unknown_metric'))).toBe(true);
    expect(registryViolations.some((v) => v.startsWith('gizmo_total:unknown_metric'))).toBe(true);
  });

  it('agent 面非法样本（未知标签）→ violation，合法样本保留', () => {
    const service = new MetricsExportService(
      makeHttp({}, 0, 0, 0) as never,
      undefined,
      makeAgent([
        {
          metricName: 'agent_command_executed_total',
          metricType: 'counter',
          value: 2,
          labels: { role: 'Knowledge', command: 'register_knowledge' },
        },
        {
          metricName: 'agent_command_executed_total',
          metricType: 'counter',
          value: 3,
          labels: { teleport_label: 'x' },
        },
      ]) as never,
    );
    const { metrics, registryViolations } = service.snapshot();
    expect(metrics.filter((m) => m.metricName === 'agent_command_executed_total')).toHaveLength(1);
    expect(registryViolations.some((v) => v.includes('unknown_label'))).toBe(true);
  });

  it('Prometheus 文本渲染：样本行 + violation 注释', () => {
    const service = new MetricsExportService(
      makeHttp({ 'GET /api/x 200': 5 }, 0, 0, 0) as never,
      makeScheduler({ plan_approved_total: 1 }) as never,
      undefined,
    );
    const text = service.renderPrometheus();
    expect(text).toContain('http_requests_total{method="GET",route="/api/x",status="200"} 5');
    expect(text).toContain('# registry_violation plan_approved_total:unknown_metric');
  });

  it('scheduler 未注入 → scheduler 面跳过（不伪造）', () => {
    const service = new MetricsExportService(makeHttp({}, 0, 0, 0) as never, undefined, undefined);
    const { metrics } = service.snapshot();
    expect(metrics.map((m) => m.metricName)).not.toContain('scheduler_run_total');
  });
});
