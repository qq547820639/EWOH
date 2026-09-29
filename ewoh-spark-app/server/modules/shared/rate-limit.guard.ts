import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { readPositiveIntSetting } from './limit-config';
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
    // NEST-523 修复（2026-08-17）：前缀匹配含无斜杠的 /health 端点
    // （原 startsWith('/health/') 漏掉 /health）。
    if (request.path?.startsWith('/health')) {
      return true;
    }
    const ttl = readPositiveIntSetting(
      process.env.RATE_LIMIT_WINDOW_SEC,
      60,
      'RATE_LIMIT_WINDOW_SEC',
      (message) => this.logger.warn(message),
    );
    const bucket = Math.floor(Date.now() / (ttl * 1000));
    // Authenticated users are bucketed by user id; anonymous clients fall back
    // to the trusted client IP resolved by Express after TRUST_PROXY is applied.
    const subject = request.userContext?.userId ?? request.ip ?? 'unknown';
    const key = `ratelimit:${request.userContext?.userId ? 'user' : 'ip'}:${subject}:${bucket}`;
    const max = readPositiveIntSetting(
      process.env.RATE_LIMIT_MAX,
      300,
      'RATE_LIMIT_MAX',
      (message) => this.logger.warn(message),
    );
    // 15.3 fault-injection：Redis 不可用 → 内存回退继续限流（安全语义不变：超出仍 429）。
    // 可观测降级信号：rate_limit_redis_fallback_total 计数（RedisService）+ 结构化日志。
    // NEST-508 修复（2026-08-17）：内存回退是 per-instance 计数，多实例部署下
    // 有效限额 = max × 实例数。部署方通过 EWOH_RATE_LIMIT_FALLBACK_INSTANCES
    // 声明实例数，回退期间按比例收紧本实例限额；如需 Redis 故障 fail-closed
    // （拒绝而非放宽），设置 EWOH_RATE_LIMIT_REDIS_FAIL_CLOSED=1（503）。
    const fallbackBefore = this.redis.memoryFallbackCount();
    const count = await this.redis.incr(key, ttl);
    const fellBack = this.redis.memoryFallbackCount() > fallbackBefore;
    let effectiveMax = max;
    if (fellBack) {
      if (process.env.EWOH_RATE_LIMIT_REDIS_FAIL_CLOSED === '1') {
        this.logger.warn(
          `rate_limit: Redis 不可用且 EWOH_RATE_LIMIT_REDIS_FAIL_CLOSED=1 → fail-closed 拒绝（key=${key}）`,
        );
        throw new HttpException(
          { code: 'RATE_LIMIT_BACKEND_UNAVAILABLE', message: 'Rate limit backend unavailable' },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      const instances = readPositiveIntSetting(
        process.env.EWOH_RATE_LIMIT_FALLBACK_INSTANCES,
        1,
        'EWOH_RATE_LIMIT_FALLBACK_INSTANCES',
        (message) => this.logger.warn(message),
      );
      effectiveMax = Math.max(1, Math.floor(max / instances));
      this.logger.warn(
        `rate_limit_redis_fallback_total: Redis 不可用，限流回退内存存储（key=${key}）；` +
          `本实例限额收紧为 ${effectiveMax}（max=${max} / ${instances} 实例；` +
          `EWOH_RATE_LIMIT_FALLBACK_INSTANCES 可调），超出仍拒绝`,
      );
    }
    if (count > effectiveMax) {
      // BUG-010 修复：429 响应添加 Retry-After 头。
      const response = context.switchToHttp().getResponse<{ setHeader: (name: string, value: string) => void }>();
      response.setHeader('Retry-After', String(ttl));
      throw new HttpException(
        { code: 'RATE_LIMITED', message: 'Too many requests', details: { limit: effectiveMax } },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
