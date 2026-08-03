import { MetricsService } from '../../../server/modules/metrics/metrics.service';

describe('MetricsService', () => {
  it('renders Prometheus counters with method, route, and status labels', () => {
    const service = new MetricsService();
    service.beginRequest();
    service.endRequest('GET', '/health/live', 200);
    service.recordDbReady(true);

    const text = service.renderPrometheus();
    expect(text).toContain(
      'ewoh_http_requests_total{method="GET",route="/health/live",status="200"} 1',
    );
    expect(text).toContain('ewoh_db_ready_checks_total{result="ok"} 1');
    expect(text).toContain('ewoh_process_uptime_seconds');
  });

  it('tracks active request count', () => {
    const service = new MetricsService();
    service.beginRequest();
    service.beginRequest();
    expect(service.snapshot().activeRequests).toBe(2);
    service.endRequest('GET', '/x', 200);
    expect(service.snapshot().activeRequests).toBe(1);
  });
});
