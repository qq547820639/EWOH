import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  HttpException,
  HttpStatus,
  Logger,
  Optional,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { RedisService } from '../shared/redis.service';

/**
 * Ingestion 鉴权 + 限流 Guard
 *
 * 鉴权：header X-Ingest-Key 需匹配环境变量 INGEST_API_KEY。
 *   - INGEST_API_KEY 未配置时 **fail-closed**（P1-INGEST-002）：
 *       · production：拒绝所有 ingest 请求（503 INGEST_API_KEY_NOT_CONFIGURED）；
 *       · 非 production：除非显式设置 INGEST_INSECURE_DEV_MODE=true，否则同样拒绝。
 *   - key 比较使用 constant-time（timingSafeEqual），避免内容级 timing 泄漏。
 * 限流：单 IP 100 req/min，超出返回 429。
 *   NEST-211：计数迁移到 RedisService（REDIS_URL 配置时多实例共享计数；
 *   Redis 不可用自动回退进程内存——单实例语义同旧版，降级有结构化日志）。
 * 机器对机器租户上下文：优先 X-Org-Id，回退 EWOH_INGEST_ORG_ID。
 */
@Injectable()
export class IngestGuard implements CanActivate {
  private readonly logger = new Logger(IngestGuard.name);
  private static readonly RATE_LIMIT = 100; // 每分钟
  private static readonly WINDOW_SECONDS = 60;

  constructor(@Optional() private readonly redis?: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const ingestKey = request.headers['x-ingest-key'] as string | undefined;
    const expectedKey = process.env.INGEST_API_KEY;

    // 鉴权（fail-closed）
    if (!expectedKey) {
      const isProd = (process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
      const insecureDev =
        (process.env.INGEST_INSECURE_DEV_MODE || '').trim().toLowerCase() === 'true';
      if (isProd || !insecureDev) {
        this.logger.warn(
          'INGEST_API_KEY 未配置，拒绝 ingest 请求（fail-closed）。' +
            (isProd
              ? ' production 环境必须配置 INGEST_API_KEY。'
              : ' 非 production 需显式 INGEST_INSECURE_DEV_MODE=true 才允许无 key 请求。'),
        );
        throw new HttpException(
          {
            code: 'INGEST_API_KEY_NOT_CONFIGURED',
            message: 'INGEST_API_KEY 未配置，拒绝 ingest 请求',
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      // 显式开发/测试模式：跳过 key 校验（仍有 org 校验与限流）
    } else if (!ingestKey || !this.keyEquals(ingestKey, expectedKey)) {
      throw new UnauthorizedException('Invalid or missing X-Ingest-Key');
    }

    // 限流（NEST-211：Redis 固定窗口计数，多实例共享；失败回退内存）。
    const ip = (request.ip || request.socket.remoteAddress || 'unknown').replace(/[^a-zA-Z0-9.:_-]/g, '_');
    const allowed = await this.allowRequest(ip);
    if (!allowed) {
      throw new HttpException('Rate limit exceeded (100 req/min)', 429);
    }

    // 机器对机器租户上下文：优先 X-Org-Id，回退 EWOH_INGEST_ORG_ID。
    const orgId =
      (request.headers['x-org-id'] as string | undefined)?.trim() ||
      process.env.EWOH_INGEST_ORG_ID?.trim();
    if (!orgId) {
      throw new UnauthorizedException(
        'X-Org-Id header or EWOH_INGEST_ORG_ID is required',
      );
    }
    (request as unknown as {
      userContext?: {
        userId: string;
        primaryOrgId: string;
        accessibleOrgIds: string[];
        isGlobalAdmin: boolean;
      };
    }).userContext = {
      userId: 'ingest',
      primaryOrgId: orgId,
      accessibleOrgIds: [orgId],
      isGlobalAdmin: false,
    };

    return true;
  }

  /** constant-time key 比较（长度不同直接拒绝，内容比较用 timingSafeEqual）。 */
  private keyEquals(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  }

  /**
   * NEST-211：Redis 固定窗口限流（incr + 首次设置 TTL）。Redis 不可用时
   * RedisService 内部回退进程内存（降级经结构化日志可观测）。
   * 回退实例必须进程级单例——内存计数在实例上，逐请求新建实例会让
   * 计数永远归零（限流失效）。
   */
  private fallbackLimiter?: RedisService;

  private async allowRequest(ip: string): Promise<boolean> {
    const limiter = this.redis ?? (this.fallbackLimiter ??= new RedisService());
    const count = await limiter.incr(
      `ingest:rate:${ip}`,
      IngestGuard.WINDOW_SECONDS,
    );
    return count <= IngestGuard.RATE_LIMIT;
  }
}
