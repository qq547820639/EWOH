import { lastValueFrom, of } from 'rxjs';
import { MetricsInterceptor } from '../../../server/modules/metrics/metrics.interceptor';
import { MetricsService } from '../../../server/modules/metrics/metrics.service';

describe('MetricsInterceptor', () => {
  it('records successful HTTP requests with route and status', async () => {
    const service = new MetricsService();
    const interceptor = new MetricsInterceptor(service);
    const context = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          path: '/example',
          route: { path: '/example' },
        }),
        getResponse: () => ({ statusCode: 201 }),
      }),
    };

    await lastValueFrom(
      interceptor.intercept(context as never, {
        handle: () => of({ ok: true }),
      } as never),
    );

    expect(service.snapshot().requests['GET /example 201']).toBe(1);
    expect(service.snapshot().activeRequests).toBe(0);
  });
});
