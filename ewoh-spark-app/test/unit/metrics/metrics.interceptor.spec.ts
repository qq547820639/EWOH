import { lastValueFrom, of, Observable } from 'rxjs';
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

  it('P2（2026-08-19 审计）：真实响应（有 on）在 finish 时刻记录最终状态码——POST 201 不再被记成 200', async () => {
    const service = new MetricsService();
    const interceptor = new MetricsInterceptor(service);
    const listeners: Record<string, Array<() => void>> = {};
    // 仿真 Express response：statusCode 初始 200，控制器逻辑（POST 默认 201）
    // 在 observable 消费后才写入最终码；finish 时读取。
    const response = {
      statusCode: 200,
      on: (event: string, listener: () => void) => {
        (listeners[event] ??= []).push(listener);
      },
    };
    const context = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'POST',
          path: '/api/observability/metrics/edge-metrics',
          route: { path: '/api/observability/metrics/edge-metrics' },
        }),
        getResponse: () => response,
      }),
    };

    await lastValueFrom(
      interceptor.intercept(context as never, {
        handle: () =>
          new Observable((subscriber) => {
            // 模拟 NestJS：handler 完成后、响应写出前写入 201（POST 默认）。
            response.statusCode = 201;
            subscriber.next({ ok: true });
            subscriber.complete();
          }),
      } as never),
    );
    // interceptor 注册了 finish/close 监听，此刻尚未触发（tap 时刻不记录）。
    expect(service.snapshot().activeRequests).toBe(1);

    // 响应写出完成 → finish 触发 → 记录最终 201（而非 tap 时刻的 200）。
    for (const fn of listeners.finish ?? []) fn();
    expect(service.snapshot().requests['POST /api/observability/metrics/edge-metrics 201']).toBe(1);
    expect(service.snapshot().activeRequests).toBe(0);

    // close 随后触发（正常完成序列）——ended 守卫防重复计数。
    for (const fn of listeners.close ?? []) fn();
    expect(service.snapshot().requests['POST /api/observability/metrics/edge-metrics 201']).toBe(1);
  });

  it('P2：客户端断连（close 且无 finish、状态码未写）→ 记录 499', async () => {
    const service = new MetricsService();
    const interceptor = new MetricsInterceptor(service);
    const listeners: Record<string, Array<() => void>> = {};
    const response = {
      statusCode: 200,
      on: (event: string, listener: () => void) => {
        (listeners[event] ??= []).push(listener);
      },
    };
    const context = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', path: '/x', route: { path: '/x' } }),
        getResponse: () => response,
      }),
    };

    await lastValueFrom(
      interceptor.intercept(context as never, { handle: () => of({}) } as never),
    );
    for (const fn of listeners.close ?? []) fn();
    expect(service.snapshot().requests['GET /x 499']).toBe(1);
    expect(service.snapshot().activeRequests).toBe(0);
  });
});
