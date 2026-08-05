import {
  MAX_BUFFER_SIZE,
  captureUnhandledError,
  clearBuffer,
  detectWhiteScreen,
  flush,
  getApiFailureRate,
  getBuffer,
  getBufferSize,
  getConflictRate,
  isWhiteScreen,
  recordApiResult,
  recordMetric,
  recordRouteLoad,
  recordSyncLatency,
  recordSyncOutcome,
  resetApiStats,
  resetSyncStats,
} from './observability';

describe('observability', () => {
  beforeEach(() => {
    clearBuffer();
    resetApiStats();
    resetSyncStats();
  });

  it('buffer respects max length (drops oldest beyond cap)', () => {
    for (let i = 0; i < MAX_BUFFER_SIZE + 50; i += 1) {
      recordMetric(`m${i}`, i);
    }
    expect(getBufferSize()).toBe(MAX_BUFFER_SIZE);
    // 最旧的 50 条被丢弃，剩下的以最后写入的为准。
    const names = getBuffer().map((m) => m.name);
    expect(names[0]).toBe(`m${50}`);
    expect(names[names.length - 1]).toBe(`m${MAX_BUFFER_SIZE + 49}`);
  });

  it('white-screen heuristic flags an empty body', () => {
    expect(isWhiteScreen(null)).toBe(true);
    expect(isWhiteScreen(undefined)).toBe(true);
    expect(isWhiteScreen({ body: { childElementCount: 0, textContent: '   ' } })).toBe(true);
    expect(
      isWhiteScreen({ body: { childElementCount: 1, textContent: 'content' } }),
    ).toBe(false);
    expect(isWhiteScreen({ body: { childElementCount: 3, textContent: '' } })).toBe(false);
  });

  it('detectWhiteScreen records a metric and returns boolean', () => {
    const sizeBefore = getBufferSize();
    const white = detectWhiteScreen({ body: { childElementCount: 0, textContent: '' } });
    expect(white).toBe(true);
    expect(getBufferSize()).toBe(sizeBefore + 1);
    expect(getBuffer()[getBuffer().length - 1].name).toBe('white.screen');
  });

  it('API failure rate increments then computes the ratio', () => {
    expect(getApiFailureRate()).toBe(0);
    recordApiResult(true);
    recordApiResult(false);
    recordApiResult(false);
    expect(getApiFailureRate()).toBeCloseTo(2 / 3);
  });

  it('unhandled error capture writes a metric with message tag', () => {
    const before = getBufferSize();
    captureUnhandledError(new Error('boom'), 'window');
    const records = getBuffer();
    expect(records.length).toBe(before + 1);
    const last = records[records.length - 1];
    expect(last.name).toBe('unhandled.error');
    expect(last.tags?.message).toContain('boom');
  });

  it('sync latency and conflict rate are recorded', () => {
    recordSyncLatency(42);
    recordSyncOutcome('ok');
    recordSyncOutcome('conflict');
    expect(getConflictRate()).toBeCloseTo(0.5);
    const names = getBuffer().map((m) => m.name);
    expect(names).toContain('sync.queue.latency.ms');
    expect(names).toContain('sync.conflict');
  });

  it('route load duration is recorded with route tag', () => {
    recordRouteLoad('/command-center', 123);
    const last = getBuffer()[getBuffer().length - 1];
    expect(last.name).toBe('route.load.ms');
    expect(last.tags?.route).toBe('/command-center');
    expect(last.value).toBe(123);
  });

  it('flush clears the buffer and returns the flushed count (no-op endpoint)', async () => {
    recordMetric('a', 1);
    recordMetric('b', 2);
    const count = await flush();
    expect(count).toBe(2);
    expect(getBufferSize()).toBe(0);
    // 再次 flush 空缓冲为 0。
    expect(await flush()).toBe(0);
  });
});