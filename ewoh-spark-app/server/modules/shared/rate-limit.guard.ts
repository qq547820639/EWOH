import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    const request = context.switchToHttp().getRequest<{
      ip?: string;
      path?: string;
      userContext?: { userId?: string };
    }>();
    if (request.path?.startsWith('/health/')) {
      return true;
    }
    const ttl = Number(process.env.RATE_LIMIT_WINDOW_SEC || 60);
    const bucket = Math.floor(Date.now() / (ttl * 1000));
    // Authenticated users are bucketed by user id; anonymous clients fall back
    // to the trusted client IP resolved by Express after TRUST_PROXY is applied.
    const subject = request.userContext?.userId ?? request.ip ?? 'unknown';
    const key = `ratelimit:${request.userContext?.userId ? 'user' : 'ip'}:${subject}:${bucket}`;
    const max = Number(process.env.RATE_LIMIT_MAX || 300);
    // 15.3 fault-injection：Redis 不可用 → 内存回退继续限流（安全语义不变：超出仍 429）。
    // 可观测降级信号：rate_limit_redis_fallback_total 计数（RedisService）+ 结构化日志。
    const fallbackBefore = this.redis.memoryFallbackCount();
    const count = await this.redis.incr(key, ttl);
    if (this.redis.memoryFallbackCount() > fallbackBefore) {
      this.logger.warn(
        `rate_limit_redis_fallback_total: Redis 不可用，限流回退内存存储（key=${key}）；限流语义保持（超出限额仍拒绝）`,
      );
    }
    if (count > max) {
      throw new HttpException(
        { code: 'RATE_LIMITED', message: 'Too many requests', details: { limit: max } },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
