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

  it('renders factory resource attributes from the environment', () => {
    const original = {
      factoryId: process.env.EWOH_FACTORY_ID,
      factoryName: process.env.EWOH_FACTORY_NAME,
      upgradeRing: process.env.EWOH_FACTORY_UPGRADE_RING,
      releaseVersion: process.env.EWOH_RELEASE_VERSION,
      region: process.env.EWOH_REGION,
    };
    process.env.EWOH_FACTORY_ID = 'factory-001';
    process.env.EWOH_FACTORY_NAME = 'Factory One';
    process.env.EWOH_FACTORY_UPGRADE_RING = 'shadow';
    process.env.EWOH_RELEASE_VERSION = '0.6.0-rc2';
    process.env.EWOH_REGION = 'cn-north-1';
    try {
      const service = new MetricsService();
      const text = service.renderPrometheus();
      expect(text).toContain(
        'ewoh_resource_info{factory_id="factory-001",factory_name="Factory One",upgrade_ring="shadow",release_version="0.6.0-rc2",region="cn-north-1"} 1',
      );
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
