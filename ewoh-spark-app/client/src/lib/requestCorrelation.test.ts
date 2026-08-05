import {
  captureTraceContext,
  extractRequestId,
  extractRequestIds,
  getTraceContext,
} from './requestCorrelation';

describe('requestCorrelation', () => {
  it('parses requestId from the unified error body', () => {
    const error = {
      response: {
        data: { error: { code: 'X', requestId: 'req-123', message: 'boom' } },
      },
    };
    expect(extractRequestId(error)).toBe('req-123');
    expect(extractRequestIds(error)).toEqual({ requestId: 'req-123' });
  });

  it('parses traceId from the x-trace-id response header', () => {
    const error = {
      response: { headers: { 'x-trace-id': 'trace-abc' } },
    };
    expect(extractRequestIds(error)).toEqual({ traceId: 'trace-abc' });
  });

  it('parses requestId from error message text as fallback', () => {
    const error = new Error('requestId: msg_fallback_99 failed');
    expect(extractRequestId(error)).toBe('msg_fallback_99');
  });

  it('captureTraceContext stores the last context and getTraceContext returns it', () => {
    captureTraceContext({
      response: { data: { error: { requestId: 'req-777' } } },
    });
    expect(getTraceContext()).toEqual({ requestId: 'req-777' });
  });

  it('returns empty string when nothing is parseable', () => {
    expect(extractRequestId(new Error('network error'))).toBe('');
    expect(extractRequestId(null)).toBe('');
    expect(extractRequestId({})).toBe('');
  });
});