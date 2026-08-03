import { SlowQueryService } from '../../../server/modules/observability/slow-query.service';

describe('SlowQueryService', () => {
  it('records bounded slow query entries and lists newest first', () => {
    const service = new SlowQueryService(2);
    service.record({
      requestId: 'req-1',
      label: 'db-transaction',
      durationMs: 1200,
      thresholdMs: 1000,
      occurredAt: '2026-08-04T00:00:01.000Z',
    });
    service.record({
      requestId: 'req-2',
      label: 'db-transaction',
      durationMs: 2100,
      thresholdMs: 1000,
      occurredAt: '2026-08-04T00:00:02.000Z',
    });
    service.record({
      requestId: 'req-3',
      label: 'db-transaction',
      durationMs: 3100,
      thresholdMs: 1000,
      occurredAt: '2026-08-04T00:00:03.000Z',
    });

    const records = service.list();

    expect(records).toHaveLength(2);
    expect(records[0].requestId).toBe('req-3');
    expect(service.count()).toBe(2);
  });

  it('clears records on demand', () => {
    const service = new SlowQueryService();
    service.record({
      label: 'db-transaction',
      durationMs: 1500,
      thresholdMs: 1000,
      occurredAt: '2026-08-04T00:00:00.000Z',
    });
    service.clear();
    expect(service.count()).toBe(0);
  });
});
