import { HttpException } from '@nestjs/common';
import { LoginRateLimitGuard } from '../../../server/modules/auth/login-rate-limit.guard';
import { RedisService } from '../../../server/modules/shared/redis.service';

describe('LoginRateLimitGuard configuration safety', () => {
  function context() {
    return {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ ip: '203.0.113.10', path: '/api/auth/login' }),
        getResponse: () => ({ setHeader: jest.fn() }),
      }),
    } as never;
  }

  function brokenRedis() {
    const redis = new RedisService();
    let count = 0;
    (redis as unknown as { client: unknown }).client = {
      incr: jest.fn(async () => ++count),
      expire: jest.fn(async () => 1),
    };
    return redis;
  }

  afterEach(() => {
    delete process.env.LOGIN_RATE_LIMIT_MAX;
  });

  it('falls back to the login limit when configuration would otherwise become NaN', async () => {
    process.env.LOGIN_RATE_LIMIT_MAX = 'disable-limit';
    const guard = new LoginRateLimitGuard(brokenRedis());
    // The fallback is 10; the 10th request passes and the 11th is rejected.
    for (let index = 0; index < 10; index += 1) {
      await expect(guard.canActivate(context())).resolves.toBe(true);
    }
    await expect(guard.canActivate(context())).rejects.toThrow(HttpException);
  });
});
