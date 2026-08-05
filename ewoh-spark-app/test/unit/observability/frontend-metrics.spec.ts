import { FrontendMetricsService } from '../../../server/modules/observability/frontend-metrics.service';

describe('frontend-metrics ingestion', () => {
  let service: FrontendMetricsService;

  beforeEach(() => {
    service = new FrontendMetricsService({
      maxRecords: 1000,
      maxBatch: 100,
      rateLimitWindowMs: 60_000,
      rateLimitMax: 5,
    });
  });

  it('accepts valid metrics and tags them with the requester org/user', () => {
    const res = service.ingest(
      {
        metrics: [
          { name: 'webvital.lcp', value: 1500, tags: { build: '0.6.0-rc4' }, at: Date.now() },
          { name: 'api.failure', value: 1 },
        ],
        page: '/command-map',
        buildVersion: '0.6.0-rc4',
      },
      { orgId: 'org-a', userId: 'u1' },
    );
    expect(res.accepted).toBe(2);
    const rows = service.query('org-a');
    expect(rows).toHaveLength(2);
    expect(rows[0].orgId).toBe('org-a');
    expect(rows[0].userId).toBe('u1');
    expect(rows[0].page).toBe('/command-map');
  });

  it('rejects a batch over the configured limit', () => {
    const metrics = Array.from({ length: 101 }, (_, i) => ({ name: `m${i}`, value: i }));
    expect(() =>
      service.ingest({ metrics }, { orgId: 'org-a' }),
    ).toThrow(/批量上限/);
  });

  it('enforces org isolation on query', () => {
    service.ingest({ metrics: [{ name: 'a', value: 1 }] }, { orgId: 'org-a' });
    service.ingest({ metrics: [{ name: 'b', value: 2 }] }, { orgId: 'org-b' });
    expect(service.query('org-a')).toHaveLength(1);
    expect(service.query('org-b')).toHaveLength(1);
    expect(service.query('org-a')[0].name).toBe('a');
  });

  it('redacts tokens and PII-bearing tag keys', () => {
    service.ingest(
      {
        metrics: [
          {
            name: 'api.failure',
            value: 1,
            tags: { authorization: 'Bearer abc.xyz.123', ok: 'https://x?token=SECRET' },
          },
        ],
      },
      { orgId: 'org-a' },
    );
    const row = service.query('org-a')[0];
    expect(String(row.tags?.authorization)).toBe('[REDACTED]');
    expect(String(row.tags?.ok)).not.toContain('SECRET');
  });

  it('rate-limits per subject after the configured max', () => {
    for (let i = 0; i < 5; i++) {
      expect(service.rateLimit('u1').allowed).toBe(true);
    }
    expect(service.rateLimit('u1').allowed).toBe(false);
    // A different subject is unaffected.
    expect(service.rateLimit('u2').allowed).toBe(true);
  });

  it('skips invalid metric entries while accepting valid ones', () => {
    const res = service.ingest(
      {
        metrics: [
          { name: '', value: 1 },
          { name: 'ok', value: NaN },
          { name: 'valid', value: 5 },
        ],
      },
      { orgId: 'org-a' },
    );
    expect(res.accepted).toBe(1);
    expect(service.query('org-a')[0].name).toBe('valid');
  });
});
