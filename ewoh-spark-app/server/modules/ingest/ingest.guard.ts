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
 * 鉴权：header X-Ingest-Key 需匹配已配置的 ingest key。
 *   - 支持按 key 绑定 org（R2-SOP-004，信任边界从"客户端自报"收敛为
 *     "凭证层绑定"）：
 *       · 环境变量 `INGEST_API_KEY_<ORG_ID>=<key>`（每个 org 一把 key，
 *         org id 后缀不区分大小写）；
 *       · 或 JSON 映射 `INGEST_API_KEYS`（别名 `INGEST_API_KEY_MAP`）：
 *         `{"<key>": "<orgId>"}`；
 *   - 向后兼容（legacy）：全局 `INGEST_API_KEY` 仍可用——
 *       · 配了 `EWOH_INGEST_ORG_ID` → 该 key 绑定到该 org；
 *       · 未配 → **legacy 无绑定模式**：org 取客户端 X-Org-Id 头（回退
 *         EWOH_INGEST_ORG_ID），每次请求打 warn 日志。多租户生产环境
 *         应迁移到 per-key 绑定（单一共享 key 泄露 = 全租户写入口）。
 *   - key 未配置时 **fail-closed**（P1-INGEST-002）：
 *       · production：拒绝所有 ingest 请求（503 INGEST_API_KEY_NOT_CONFIGURED）；
 *       · 非 production：除非显式设置 INGEST_INSECURE_DEV_MODE=true，否则同样拒绝。
 *   - key 比较使用 constant-time（timingSafeEqual），避免内容级 timing 泄漏。
 * 限流：单 IP 100 req/min，超出返回 429。
 *   NEST-211：计数迁移到 RedisService（REDIS_URL 配置时多实例共享计数；
 *   Redis 不可用自动回退进程内存——单实例语义同旧版，降级有结构化日志）。
 * 机器对机器租户上下文（R2-SOP-004）：
 *   - key 有 org 绑定 → primaryOrgId = 绑定 org；客户端自报 X-Org-Id 若与
 *     绑定不一致 → 403（防 key 被用于跨绑定域注入）；
 *   - legacy 无绑定模式 → 优先 X-Org-Id，回退 EWOH_INGEST_ORG_ID（兼容旧行为）。
 */
@Injectable()
export class IngestGuard implements CanActivate {
  private readonly logger = new Logger(IngestGuard.name);
  private static readonly RATE_LIMIT = 100; // 每分钟
  private static readonly WINDOW_SECONDS = 60;

  /** key→org 绑定（惰性解析，进程内缓存）。null 值 = legacy 无绑定 key。 */
  private keyBindings?: Map<string, string | null>;
  private warnedLegacyUnbound = false;

  constructor(@Optional() private readonly redis?: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const ingestKey = request.headers['x-ingest-key'] as string | undefined;

    // 解析 key→org 绑定表（R2-SOP-004）。
    const bindings = this.resolveKeyBindings();
    const legacyKey = process.env.INGEST_API_KEY;
    const anyKeyConfigured = bindings.size > 0 || !!legacyKey;

    // 鉴权（fail-closed）
    if (!anyKeyConfigured) {
      const isProd = (process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
      const insecureDev =
        (process.env.INGEST_INSECURE_DEV_MODE || '').trim().toLowerCase() === 'true';
      if (isProd || !insecureDev) {
        this.logger.warn(
          'INGEST_API_KEY 未配置，拒绝 ingest 请求（fail-closed）。' +
            (isProd
              ? ' production 环境必须配置 INGEST_API_KEY（推荐 per-key：INGEST_API_KEY_<ORG_ID> 或 INGEST_API_KEYS JSON 映射）。'
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
    } else {
      const matched = this.matchKey(ingestKey, bindings, legacyKey);
      if (!matched) {
        throw new UnauthorizedException('Invalid or missing X-Ingest-Key');
      }
    }

    // 限流（NEST-211：Redis 固定窗口计数，多实例共享；失败回退内存）。
    const ip = (request.ip || request.socket.remoteAddress || 'unknown').replace(/[^a-zA-Z0-9.:_-]/g, '_');
    const allowed = await this.allowRequest(ip);
    if (!allowed) {
      throw new HttpException('Rate limit exceeded (100 req/min)', 429);
    }

    // 机器对机器租户上下文（R2-SOP-004：key 绑定优先，客户端自报仅在
    // key 绑定域内或 legacy 无绑定模式下接受）。
    const headerOrgId = (request.headers['x-org-id'] as string | undefined)?.trim();
    const fallbackOrgId = process.env.EWOH_INGEST_ORG_ID?.trim();
    let orgId: string;
    if (anyKeyConfigured) {
      const matched = this.matchKey(ingestKey, bindings, legacyKey);
      if (matched?.boundOrgId) {
        // key 绑定域：绑定 org 为准；自报 org 不一致 → 拒绝。
        if (headerOrgId && headerOrgId.toLowerCase() !== matched.boundOrgId.toLowerCase()) {
          throw new HttpException(
            {
              code: 'INGEST_ORG_MISMATCH',
              message: 'X-Org-Id 与该 ingest key 的绑定 org 不一致，拒绝请求',
            },
            HttpStatus.FORBIDDEN,
          );
        }
        orgId = matched.boundOrgId;
      } else {
        // legacy 无绑定 key：org 取客户端自报（回退全局默认），warn 提示迁移。
        orgId = headerOrgId || fallbackOrgId || '';
        if (!this.warnedLegacyUnbound) {
          this.warnedLegacyUnbound = true;
          this.logger.warn(
            'INGEST_API_KEY 未绑定 org（未配置 EWOH_INGEST_ORG_ID / per-key 绑定），' +
              '租户上下文回退客户端自报 X-Org-Id（legacy 兼容）。多租户生产环境请配置 ' +
              'INGEST_API_KEY_<ORG_ID> 或 INGEST_API_KEYS 映射收敛信任边界（R2-SOP-004）。',
          );
        }
      }
    } else {
      orgId = headerOrgId || fallbackOrgId || '';
    }
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

  /**
   * 解析 key→org 绑定表（R2-SOP-004）：
   *  1. INGEST_API_KEY_<ORG_ID>=<key>（env 扫描，后缀即 org id）；
   *  2. INGEST_API_KEYS / INGEST_API_KEY_MAP：JSON `{"<key>": "<orgId>"}`；
   *  3. legacy INGEST_API_KEY：配了 EWOH_INGEST_ORG_ID → 绑定该 org，
   *     否则无绑定（Map 值 null，走 legacy 自报路径）。
   */
  private resolveKeyBindings(): Map<string, string | null> {
    if (this.keyBindings) return this.keyBindings;
    const bindings = new Map<string, string | null>();
    for (const [name, value] of Object.entries(process.env)) {
      if (!value) continue;
      const m = /^INGEST_API_KEY_(.+)$/.exec(name);
      // INGEST_API_KEY 本体单独处理；别名 INGEST_API_KEYS/INGEST_API_KEY_MAP 走 JSON。
      if (m && name !== 'INGEST_API_KEYS' && name !== 'INGEST_API_KEY_MAP') {
        const orgId = m[1].trim();
        if (orgId) bindings.set(value, orgId);
      }
    }
    const jsonMap =
      process.env.INGEST_API_KEYS?.trim() || process.env.INGEST_API_KEY_MAP?.trim();
    if (jsonMap) {
      try {
        const parsed = JSON.parse(jsonMap) as Record<string, string>;
        for (const [key, orgId] of Object.entries(parsed)) {
          if (key && typeof orgId === 'string' && orgId.trim()) {
            bindings.set(key, orgId.trim());
          }
        }
      } catch (error) {
        this.logger.error(
          `INGEST_API_KEYS JSON 解析失败（忽略该映射）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const legacyKey = process.env.INGEST_API_KEY?.trim();
    if (legacyKey && !bindings.has(legacyKey)) {
      bindings.set(legacyKey, process.env.EWOH_INGEST_ORG_ID?.trim() || null);
    }
    this.keyBindings = bindings;
    return bindings;
  }

  /** constant-time 匹配请求 key；返回命中的绑定（无绑定 key 返回 boundOrgId=null）。 */
  private matchKey(
    ingestKey: string | undefined,
    bindings: Map<string, string | null>,
    legacyKey: string | undefined,
  ): { boundOrgId: string | null } | null {
    if (!ingestKey) return null;
    if (legacyKey && this.keyEquals(ingestKey, legacyKey)) {
      return { boundOrgId: bindings.get(legacyKey) ?? null };
    }
    for (const [key, orgId] of bindings) {
      if (key !== legacyKey && this.keyEquals(ingestKey, key)) {
        return { boundOrgId: orgId };
      }
    }
    return null;
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
