import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * Ingestion 鉴权 + 限流 Guard
 *
 * 鉴权：header X-Ingest-Key 需匹配环境变量 INGEST_API_KEY
 *   - 若 INGEST_API_KEY 未配置，则允许所有请求（开发模式）
 * 限流：单 IP 100 req/min，超出返回 429
 */
@Injectable()
export class IngestGuard implements CanActivate {
  private readonly logger = new Logger(IngestGuard.name);
  private static readonly RATE_LIMIT = 100; // 每分钟
  private static readonly WINDOW_MS = 60_000;

  /** ip -> 时间戳数组（滑动窗口） */
  private hits = new Map<string, number[]>();

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const ingestKey = request.headers['x-ingest-key'] as string | undefined;
    const expectedKey = process.env.INGEST_API_KEY;

    // 鉴权
    if (expectedKey) {
      if (!ingestKey || ingestKey !== expectedKey) {
        throw new UnauthorizedException('Invalid or missing X-Ingest-Key');
      }
    }

    // 限流
    const ip = (request.ip || request.socket.remoteAddress || 'unknown').replace('::ffff:', '');
    if (!this.allowRequest(ip)) {
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

  private allowRequest(ip: string): boolean {
    const now = Date.now();
    const windowStart = now - IngestGuard.WINDOW_MS;
    const arr = this.hits.get(ip) ?? [];
    // 清理过期记录
    const fresh = arr.filter((t) => t > windowStart);
    if (fresh.length >= IngestGuard.RATE_LIMIT) {
      this.hits.set(ip, fresh);
      return false;
    }
    fresh.push(now);
    this.hits.set(ip, fresh);
    return true;
  }
}
