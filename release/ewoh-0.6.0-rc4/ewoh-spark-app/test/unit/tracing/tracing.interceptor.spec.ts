import { lastValueFrom, of, throwError } from 'rxjs';
import { currentRequestContext } from '../../../server/common/request-context';
import { TracingInterceptor } from '../../../server/modules/tracing/tracing.interceptor';
import { TracingService } from '../../../server/modules/tracing/tracing.service';

function context(response: { setHeader: (n: string, v: string) => void; statusCode: number }) {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => ({ method: 'GET', path: '/api/me', route: { path: '/api/me' } }),
      getResponse: () => response,
    }),
  };
}

describe('TracingInterceptor', () => {
  it('adds trace header and records success', async () => {
    const service = new TracingService();
    const interceptor = new TracingInterceptor(service);
    const headers: Record<string, string> = {};
    const response = {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
      statusCode: 200,
    };
    let seenRequestId: string | undefined;

    await lastValueFrom(
      interceptor.intercept(context(response) as never, {
        handle: () => {
          seenRequestId = currentRequestContext()?.requestId;
          return of({ ok: true });
        },
      } as never),
    );

    expect(headers['x-trace-id']).toMatch(/^[a-f0-9]{32}$/);
    expect(seenRequestId).toBe(headers['x-trace-id']);
    const traces = service.list();
    expect(traces).toHaveLength(1);
    expect(traces[0].path).toBe('/api/me');
    expect(traces[0].status).toBe(200);
  });

  it('records errors with status', async () => {
    const service = new TracingService();
    const interceptor = new TracingInterceptor(service);
    const response = {
      setHeader: () => undefined,
      statusCode: 500,
    };
    await expect(
      lastValueFrom(
        interceptor.intercept(context(response) as never, {
          handle: () => throwError(() => ({ status: 404, message: 'missing' })),
        } as never),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(service.list()[0].status).toBe(404);
    expect(service.list()[0].error).toContain('missing');
  });
});
