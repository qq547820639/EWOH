import { TracingService } from '../../../server/modules/tracing/tracing.service';

describe('TracingService', () => {
  it('records entries and returns newest first', () => {
    const service = new TracingService(5);
    for (let index = 1; index <= 6; index += 1) {
      service.record({
        traceId: `trace-${index}`,
        spanId: `span-${index}`,
        method: 'GET',
        path: '/api/test',
        status: 200,
        durationMs: 1,
        startedAt: '2026-08-03T00:00:00Z',
        finishedAt: '2026-08-03T00:00:01Z',
      });
    }
    const traces = service.list();
    expect(traces).toHaveLength(5);
    expect(traces[0].traceId).toBe('trace-6');
    expect(traces[4].traceId).toBe('trace-2');
  });

  it('limits list output', () => {
    const service = new TracingService();
    for (let index = 0; index < 10; index += 1) {
      service.record({
        traceId: `t${index}`,
        spanId: `s${index}`,
        method: 'GET',
        path: '/',
        status: 200,
        durationMs: 1,
        startedAt: '',
        finishedAt: '',
      });
    }
    expect(service.list(3)).toHaveLength(3);
  });
});
