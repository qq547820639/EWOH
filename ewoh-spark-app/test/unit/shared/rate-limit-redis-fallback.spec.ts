/* Task 15.3 fault-injection：Redis 不可用 → 限流内存回退必须可观测（禁止 silent fallback）。
 *
 * 覆盖：
 *   - Redis 连接不可用（注入失败 client）→ RateLimitGuard 回退内存存储继续限流
 *     （安全语义不变：超出限额仍 429，绝不清零/静默放行）；
 *   - 可观测信号：rate_limit_redis_fallback_total 计数（RedisService.memoryFallbackCount）
 *     + 结构化日志（RateLimitGuard logger.warn 提及 metric 名）；
 *   - RedisService 各操作（get/set/incr/del）回退内存时均累计计数并记录日志；
 *   - Redis 正常时不触发回退计数（无噪声）。
 */
import { RedisService } from '../../../server/modules/shared/redis.service';
import { RateLimitGuard } from '../../../server/modules/shared/rate-limit.guard';

describe('Redis 不可用（Task 15.3 fault-injection）', () => {
  function context(overrides: Record<string, unknown>) {
    return {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => overrides,
        getResponse: () => ({ setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() }),
      }),
    } as never;
  }

  /** 构造一个"Redis 连接不可用"的 RedisService（client 全部操作 reject）。 */
  function makeBrokenRedis() {
    const redis = new RedisService();
    const client = {
      incr: jest.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379')),
      get: jest.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379')),
      set: jest.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379')),
      del: jest.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379')),
      expire: jest.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379')),
      ping: jest.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379')),
    };
    (redis as unknown as { client: unknown }).client = client;
    return { redis, client };
  }

  it('guard 回退内存继续限流（安全语义不变），且降级可观测：metric 计数 + 结构化日志', async () => {
    process.env.RATE_LIMIT_MAX = '3';
    const { redis } = makeBrokenRedis();
    const guard = new RateLimitGuard(redis);
    const warnSpy = jest.spyOn(
      (guard as unknown as { logger: { warn: (message: string) => void } }).logger,
      'warn',
    );

    const req = context({ ip: '127.0.0.1', path: '/api/models' });
    expect(redis.memoryFallbackCount()).toBe(0);

    await expect(guard.canActivate(req)).resolves.toBe(true);
    await expect(guard.canActivate(req)).resolves.toBe(true);
    await expect(guard.canActivate(req)).resolves.toBe(true);
    // 超出限流仍被拒绝（fail-closed 语义保持：Redis 挂了不清零、不静默放行）。
    await expect(guard.canActivate(req)).rejects.toThrow('Too many requests');

    // 15.6：降级可观测 —— metric（rate_limit_redis_fallback_total）计数 + 结构化日志。
    expect(redis.memoryFallbackCount()).toBeGreaterThan(0);
    const logged = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('rate_limit_redis_fallback_total');
    warnSpy.mockRestore();
    delete process.env.RATE_LIMIT_MAX;
  });

  it('RedisService 各操作回退内存时均累计 metric 并记录日志（get/set/incr/del）', async () => {
    const { redis } = makeBrokenRedis();
    const warnSpy = jest.spyOn(
      (redis as unknown as { logger: { warn: (message: string) => void } }).logger,
      'warn',
    );

    await expect(redis.get('k')).resolves.toBeNull();
    await redis.set('k', 1, 60);
    // 内存回退语义：set 已写入 k=1，incr 在其上自增 → 2。
    await expect(redis.incr('k', 60)).resolves.toBe(2);
    await redis.del('k');
    await expect(redis.ping()).resolves.toBe(false);

    // get/set/incr/del 各一次内存回退；ping 无内存回退不计数。
    expect(redis.memoryFallbackCount()).toBe(4);
    const logged = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('rate_limit_redis_fallback_total');
    expect(logged).toContain('redis.incr unavailable');
    warnSpy.mockRestore();
  });

  it('Redis 正常（client 可用）时不触发回退计数（无噪声）', async () => {
    const redis = new RedisService();
    const client = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
      ping: jest.fn().mockResolvedValue('PONG'),
    };
    (redis as unknown as { client: unknown }).client = client;

    await expect(redis.get('k')).resolves.toBeNull();
    await redis.set('k', 1, 60);
    await expect(redis.incr('k', 60)).resolves.toBe(1);
    await redis.del('k');
    await expect(redis.ping()).resolves.toBe(true);

    expect(redis.memoryFallbackCount()).toBe(0);
  });
});
