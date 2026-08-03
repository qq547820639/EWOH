import { NotFoundException } from '@nestjs/common';
import { MetricsController } from '../../../server/modules/metrics/metrics.controller';

describe('MetricsController', () => {
  const original = process.env.METRICS_ENABLED;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.METRICS_ENABLED;
    } else {
      process.env.METRICS_ENABLED = original;
    }
  });

  it('returns Prometheus text when metrics are enabled', () => {
    process.env.METRICS_ENABLED = 'true';
    const metrics = {
      renderPrometheus: jest.fn(() => 'ewoh_http_requests_total 1'),
    };
    const response = { setHeader: jest.fn() };
    const controller = new MetricsController(metrics as never);

    const body = controller.metricsText(response as never);

    expect(body).toContain('ewoh_http_requests_total');
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      expect.stringContaining('text/plain'),
    );
  });

  it('returns 404 when metrics are disabled', () => {
    process.env.METRICS_ENABLED = 'false';
    const controller = new MetricsController({} as never);
    expect(() =>
      controller.metricsText({ setHeader: jest.fn() } as never),
    ).toThrow(NotFoundException);
  });
});
