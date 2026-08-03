import { RedisService } from '../../../server/modules/shared/redis.service';
import { RateLimitGuard } from '../../../server/modules/shared/rate-limit.guard';

describe('rate limit guard (memory fallback)', () => {
  function context(overrides: Record<string, unknown>) {
    return {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => overrides,
      }),
    } as never;
  }

  it('allows within limit and rejects over limit', async () => {
    process.env.RATE_LIMIT_MAX = '3';
    const redis = new RedisService();
    const guard = new RateLimitGuard(redis);
    const anonymous = context({ ip: '127.0.0.1', path: '/api/models' });
    await expect(guard.canActivate(anonymous)).resolves.toBe(true);
    await expect(guard.canActivate(anonymous)).resolves.toBe(true);
    await expect(guard.canActivate(anonymous)).resolves.toBe(true);
    await expect(guard.canActivate(anonymous)).rejects.toThrow('Too many requests');
  });

  it('buckets authenticated requests by user id instead of shared proxy IP', async () => {
    process.env.RATE_LIMIT_MAX = '2';
    const redis = new RedisService();
    const guard = new RateLimitGuard(redis);
    const userA = context({
      ip: '10.0.0.1',
      path: '/api/models',
      userContext: { userId: 'user-a' },
    });
    const userB = context({
      ip: '10.0.0.1',
      path: '/api/models',
      userContext: { userId: 'user-b' },
    });

    await expect(guard.canActivate(userA)).resolves.toBe(true);
    await expect(guard.canActivate(userA)).resolves.toBe(true);
    await expect(guard.canActivate(userB)).resolves.toBe(true);
    await expect(guard.canActivate(userB)).resolves.toBe(true);
    await expect(guard.canActivate(userA)).rejects.toThrow('Too many requests');
  });
});
