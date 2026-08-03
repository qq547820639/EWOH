import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

@Injectable()
export class RateLimitGuard implements CanActivate {
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
    const count = await this.redis.incr(key, ttl);
    if (count > max) {
      throw new HttpException(
        { code: 'RATE_LIMITED', message: 'Too many requests', details: { limit: max } },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
