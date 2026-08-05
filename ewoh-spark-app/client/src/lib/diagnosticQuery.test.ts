import {
  buildTraceLookupQuery,
  filterTraceRecord,
  lookupTraceByRequestId,
  lookupTraces,
  type TraceLookupQuery,
} from './diagnosticQuery';
import type { TraceRecord } from '../api/tracing';

function record(overrides: Partial<TraceRecord>): TraceRecord {
  return {
    traceId: 'trace-1',
    spanId: 'span-1',
    method: 'GET',
    path: '/api/factory/map',
    status: 200,
    durationMs: 10,
    startedAt: '2026-08-05T00:00:00.000Z',
    finishedAt: '2026-08-05T00:00:00.010Z',
    ...overrides,
  };
}

describe('diagnosticQuery', () => {
  it('builds a query string from filters', () => {
    const qs = buildTraceLookupQuery({
      requestId: 'req-1',
      user: 'alice',
      org: 'org-42',
      page: 'map',
      timeRangeMs: 60000,
      limit: 50,
    });
    expect(qs).toContain('requestId=req-1');
    expect(qs).toContain('user=alice');
    expect(qs).toContain('org=org-42');
    expect(qs).toContain('page=map');
    expect(qs).toContain('timeRangeMs=60000');
    expect(qs).toContain('limit=50');
  });

  it('builds an empty string when no filters are set', () => {
    expect(buildTraceLookupQuery({})).toBe('');
  });

  it('filterTraceRecord matches by requestId/traceId', () => {
    const query: TraceLookupQuery = { requestId: 'trace-9' };
    expect(filterTraceRecord(record({ traceId: 'trace-9' }), query)).toBe(true);
    expect(filterTraceRecord(record({ traceId: 'trace-1' }), query)).toBe(false);
  });

  it('filterTraceRecord respects time range', () => {
    const query: TraceLookupQuery = { timeRangeMs: 1000 };
    expect(
      filterTraceRecord(record({ startedAt: new Date().toISOString() }), query),
    ).toBe(true);
    expect(
      filterTraceRecord(record({ startedAt: '2020-01-01T00:00:00.000Z' }), query),
    ).toBe(false);
  });

  it('lookupTraces filters through the injected fetcher', async () => {
    const traces = [
      record({ traceId: 'trace-1', path: '/api/factory/map' }),
      record({ traceId: 'trace-2', path: '/api/work/flow' }),
    ];
    const result = await lookupTraces({ requestId: 'trace-2' }, async () => traces);
    expect(result).toHaveLength(1);
    expect(result[0].traceId).toBe('trace-2');
  });

  it('lookupTraceByRequestId returns matching traces', async () => {
    const traces = [record({ traceId: 'abc' }), record({ traceId: 'def' })];
    const result = await lookupTraceByRequestId('def', async () => traces);
    expect(result).toHaveLength(1);
    expect(result[0].traceId).toBe('def');
  });
});