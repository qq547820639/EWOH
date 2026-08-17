import { HttpException, NotFoundException } from '@nestjs/common';
import { MetricsController } from '../../../server/modules/metrics/metrics.controller';

function fakeRequest(authorization?: string): { headers: Record<string, string> } {
  return { headers: authorization ? { authorization } : {} };
}

describe('MetricsController', () => {
  const original = process.env.METRICS_ENABLED;
  const originalToken = process.env.METRICS_BEARER_TOKEN;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    const restore = (name: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore('METRICS_ENABLED', original);
    restore('METRICS_BEARER_TOKEN', originalToken);
    restore('NODE_ENV', originalNodeEnv);
  });

  it('returns Prometheus text when metrics are enabled (non-production, no token configured)', () => {
    process.env.METRICS_ENABLED = 'true';
    delete process.env.METRICS_BEARER_TOKEN;
    delete process.env.NODE_ENV;
    const metrics = {
      renderPrometheus: jest.fn(() => 'ewoh_http_requests_total 1'),
    };
    const response = { setHeader: jest.fn() };
    const controller = new MetricsController(metrics as never);

    const body = controller.metricsText(
      fakeRequest() as never,
      response as never,
    );

    expect(body).toContain('ewoh_http_requests_total');
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      expect.stringContaining('text/plain'),
    );
  });

  it('returns 404 when metrics are disabled', () => {
    process.env.METRICS_ENABLED = 'false';
    delete process.env.METRICS_BEARER_TOKEN;
    const controller = new MetricsController({} as never);
    expect(() =>
      controller.metricsText(
        fakeRequest() as never,
        { setHeader: jest.fn() } as never,
      ),
    ).toThrow(NotFoundException);
  });

  it('NEST-427: production without METRICS_BEARER_TOKEN fail-closed → 404', () => {
    delete process.env.METRICS_ENABLED;
    delete process.env.METRICS_BEARER_TOKEN;
    process.env.NODE_ENV = 'production';
    const controller = new MetricsController({} as never);
    expect(() =>
      controller.metricsText(
        fakeRequest() as never,
        { setHeader: jest.fn() } as never,
      ),
    ).toThrow(NotFoundException);
  });

  it('NEST-427: configured bearer token rejects mismatched credentials → 401', () => {
    delete process.env.METRICS_ENABLED;
    process.env.METRICS_BEARER_TOKEN = 'secret-token';
    delete process.env.NODE_ENV;
    const controller = new MetricsController({} as never);
    expect(() =>
      controller.metricsText(
        fakeRequest('Bearer wrong-token') as never,
        { setHeader: jest.fn() } as never,
      ),
    ).toThrow(HttpException);
    expect(() =>
      controller.metricsText(
        fakeRequest() as never,
        { setHeader: jest.fn() } as never,
      ),
    ).toThrow(HttpException);
  });

  it('NEST-427: configured bearer token accepts matching credentials', () => {
    delete process.env.METRICS_ENABLED;
    process.env.METRICS_BEARER_TOKEN = 'secret-token';
    delete process.env.NODE_ENV;
    const metrics = {
      renderPrometheus: jest.fn(() => 'ewoh_http_requests_total 1'),
    };
    const response = { setHeader: jest.fn() };
    const controller = new MetricsController(metrics as never);
    const body = controller.metricsText(
      fakeRequest('Bearer secret-token') as never,
      response as never,
    );
    expect(body).toContain('ewoh_http_requests_total');
  });
});
