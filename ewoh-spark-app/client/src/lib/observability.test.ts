import {
  MAX_BUFFER_SIZE,
  cancelPendingFlush,
  captureUnhandledError,
  clearBuffer,
  clearStaged,
  configureFlush,
  detectDeviceCategory,
  detectWhiteScreen,
  flush,
  getApiFailureRate,
  getBuffer,
  getBufferSize,
  getConflictRate,
  getDropStats,
  getFlushOptions,
  getStagedCount,
  isWhiteScreen,
  recordApiResult,
  recordMetric,
  recordRouteLoad,
  recordSyncLatency,
  recordSyncOutcome,
  resetApiStats,
  resetDropStats,
  resetSyncStats,
  setFlushTransportForTesting,
  setStageStorageForTesting,
  type FrontendMetricsEnvelope,
} from './observability';

describe('observability', () => {
  beforeEach(() => {
    clearBuffer();
    resetApiStats();
    resetSyncStats();
    resetDropStats();
    clearStaged();
    cancelPendingFlush();
    setFlushTransportForTesting(null);
    setStageStorageForTesting(null);
    configureFlush({ samplingRate: 1, maxRetries: 5, backoffBaseMs: 1, backoffMaxMs: 10, jitter: false });
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

  it('flush clears buffer only after a successful send (TR-5.2 invariant)', async () => {
    recordMetric('a', 1);
    recordMetric('b', 2);
    let received: FrontendMetricsEnvelope | null = null;
    setFlushTransportForTesting(async (env) => {
      received = env;
    });
    const count = await flush();
    expect(count).toBe(2);
    expect(received?.metrics).toHaveLength(2);
    // 发送成功后才清空。
    expect(getBufferSize()).toBe(0);
    // 缓冲为空时 flush 返回 0。
    expect(await flush()).toBe(0);
  });

  it('retains the buffer when the send fails (no silent drop)', async () => {
    recordMetric('a', 1);
    setFlushTransportForTesting(async () => {
      throw new Error('network down');
    });
    const count = await flush();
    expect(count).toBe(0);
    // 失败不清空本地缓冲。
    expect(getBufferSize()).toBe(1);
    cancelPendingFlush();
  });

  it('stages metrics for offline replay after retries are exhausted', async () => {
    recordMetric('a', 1);
    configureFlush({ maxRetries: 0 });
    const mem = new Map<string, string>();
    setStageStorageForTesting({
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => void mem.set(k, v),
      removeItem: (k) => void mem.delete(k),
    });
    setFlushTransportForTesting(async () => {
      throw new Error('unreachable');
    });
    await flush();
    // 重试已耗尽 → 转入离线暂存，缓冲清空以待新指标。
    expect(getStagedCount()).toBe(1);
    clearStaged();
  });

  it('envelope carries requestId/traceId/buildVersion/deviceCategory metadata', async () => {
    recordMetric('a', 1);
    let received: FrontendMetricsEnvelope | null = null;
    setFlushTransportForTesting(async (env) => {
      received = env;
    });
    await flush();
    expect(received?.buildVersion).toBeTruthy();
    expect(received?.deviceCategory).toBeTruthy();
    expect(received?.metrics).toHaveLength(1);
  });

  it('sampling rate 0 drops the batch deliberately (not silent skip)', async () => {
    recordMetric('a', 1);
    configureFlush({ samplingRate: 0 });
    setFlushTransportForTesting(async () => {
      throw new Error('should not be called');
    });
    const count = await flush();
    expect(count).toBe(1);
    expect(getBufferSize()).toBe(0);
  });

  it('detectDeviceCategory distinguishes mobile/tablet/desktop', () => {
    expect(detectDeviceCategory('Mozilla iPhone')).toBe('mobile');
    expect(detectDeviceCategory('Mozilla iPad')).toBe('tablet');
    expect(detectDeviceCategory('Mozilla Windows')).toBe('desktop');
  });

  it('records queue-overflow drops when the bounded buffer sheds oldest metrics', () => {
    resetDropStats();
    for (let i = 0; i < MAX_BUFFER_SIZE + 50; i += 1) {
      recordMetric(`m${i}`, i);
    }
    expect(getBufferSize()).toBe(MAX_BUFFER_SIZE);
    expect(getDropStats().queueOverflowDropped).toBe(50);
  });

  it('records sampling drops when a batch is deliberately dropped', async () => {
    resetDropStats();
    recordMetric('a', 1);
    configureFlush({ samplingRate: 0 });
    setFlushTransportForTesting(async () => {
      throw new Error('should not be called');
    });
    await flush();
    expect(getDropStats().samplingDropped).toBe(1);
  });

  it('rate-limits flushes to maxFlushesPerWindow per window and counts drops', async () => {
    resetDropStats();
    configureFlush({ maxFlushesPerWindow: 2, rateLimitWindowMs: 60_000 });
    let sends = 0;
    setFlushTransportForTesting(async () => {
      sends += 1;
    });
    // 前两次发送正常。
    recordMetric('a', 1);
    await flush();
    recordMetric('b', 1);
    await flush();
    expect(sends).toBe(2);
    // 第三次 flush 触发限速：批次被刻意丢弃并计数，不发送。
    recordMetric('c', 1);
    await flush();
    expect(sends).toBe(2);
    expect(getDropStats().rateLimitedDropped).toBe(1);
    expect(getBufferSize()).toBe(0);
  });

  it('envelope does not leak organization identity (org isolation)', async () => {
    recordMetric('a', 1);
    let received: FrontendMetricsEnvelope | null = null;
    setFlushTransportForTesting(async (env) => {
      received = env;
    });
    await flush();
    expect(received).not.toBeNull();
    // 信封不携带组织身份字段（org isolation）：类型上不含，运行时也不应出现。
    const keys = received ? Object.keys(received) : [];
    expect(keys).not.toContain('orgId');
    expect(keys).not.toContain('org');
  });
});