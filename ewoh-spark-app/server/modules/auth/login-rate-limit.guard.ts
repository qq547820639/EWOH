import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { readPositiveIntSetting } from '../shared/limit-config';
import { RedisService } from '../shared/redis.service';

/**
 * 登录专用限流守卫 —— 比全局 RateLimitGuard（默认 300/min）严格得多。
 * 默认配置：同一 IP 15 分钟内最多 10 次登录尝试，超出返回 429。
 * 环境变量可覆盖：
 *   LOGIN_RATE_LIMIT_WINDOW_SEC  窗口秒数（默认 900 = 15min）
 *   LOGIN_RATE_LIMIT_MAX         窗口内最大尝试次数（默认 10）
 */
@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(LoginRateLimitGuard.name);

  constructor(private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      ip?: string;
      path?: string;
    }>();

    const onInvalid = (message: string) => this.logger.warn(message);
    const ttl = readPositiveIntSetting(
      process.env.LOGIN_RATE_LIMIT_WINDOW_SEC,
      900,
      'LOGIN_RATE_LIMIT_WINDOW_SEC',
      onInvalid,
    );
    const max = readPositiveIntSetting(
      process.env.LOGIN_RATE_LIMIT_MAX,
      10,
      'LOGIN_RATE_LIMIT_MAX',
      onInvalid,
    );
    const subject = request.ip ?? 'unknown';
    const bucket = Math.floor(Date.now() / (ttl * 1000));
    const key = `login_ratelimit:ip:${subject}:${bucket}`;

    const fallbackBefore = this.redis.memoryFallbackCount();
    const count = await this.redis.incr(key, ttl);
    const fellBack = this.redis.memoryFallbackCount() > fallbackBefore;

    let effectiveMax = max;
    if (fellBack) {
      // Redis 不可用时按实例数收紧限额
      const instances = readPositiveIntSetting(
        process.env.EWOH_RATE_LIMIT_FALLBACK_INSTANCES,
        1,
        'EWOH_RATE_LIMIT_FALLBACK_INSTANCES',
        (message) => this.logger.warn(message),
      );
      effectiveMax = Math.max(1, Math.floor(max / instances));
      this.logger.warn(
        `login_rate_limit_redis_fallback: Redis 不可用，登录限流回退内存存储（key=${key}）；` +
          `本实例限额收紧为 ${effectiveMax}（max=${max} / ${instances} 实例）`,
      );
    }

    if (count > effectiveMax) {
      this.logger.warn(
        `login_rate_limited: IP ${subject} 超过登录限流（${count}/${effectiveMax} in ${ttl}s window）`,
      );
      // BUG-010 修复：429 响应添加 Retry-After 头。
      const response = context.switchToHttp().getResponse<{ setHeader: (name: string, value: string) => void }>();
      response.setHeader('Retry-After', String(ttl));
      throw new HttpException(
        {
          code: 'RATE_LIMITED',
          message: '登录尝试过于频繁，请稍后再试',
          details: { limit: effectiveMax, retryAfterSeconds: ttl },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
