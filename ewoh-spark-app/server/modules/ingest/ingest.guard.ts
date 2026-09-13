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
import { resolveIngestKeyConfiguration } from './ingest-key-config';

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
 * 限流：单 IP 默认 100 req/min（可用 INGEST_RATE_LIMIT / INGEST_RATE_LIMIT_WINDOW_SEC
 * 调整——多源传感器机群通常共用一个边缘出口 IP），超出返回 429。
 *   NEST-211：计数迁移到 RedisService（REDIS_URL 配置时多实例共享计数；
 *   Redis 不可用自动回退进程内存——单实例语义同旧版，降级有结构化日志）。
 * 机器对机器租户上下文（R2-SOP-004）：
 *   - key 有 org 绑定 → primaryOrgId = 绑定 org；客户端自报 X-Org-Id 若与
 *     绑定不一致 → 403（防 key 被用于跨绑定域注入）；
 *   - legacy 无绑定模式 → 优先 X-Org-Id，回退 EWOH_INGEST_ORG_ID（兼容旧行为）。
 */
/** 配置解析告警用的模块级 logger（静态字段初始化期没有实例 logger）。 */
const configLogger = new Logger('IngestGuardConfig');

/**
 * 解析正整数环境变量；非法/缺失回退默认（并留痕，不静默用错值）。
 * 放在模块作用域：静态字段初始化期即可用，且避免实例依赖。
 */
function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    configLogger.warn(`非法限流配置 "${raw}"，回退默认 ${fallback}（配置错误必须可见）`);
    return fallback;
  }
  return Math.floor(parsed);
}

@Injectable()
export class IngestGuard implements CanActivate {
  private readonly logger = new Logger(IngestGuard.name);
  /**
   * 摄入限流（默认 100 请求/分钟/IP，保持历史行为）。
   *
   * 2026-09-10：原为硬编码常量——但多源上行（环境/摄像头/定位 + 外骨骼）落地后，
   * **整个传感器机群通常共用一个边缘出口 IP**，100/min 会被正常流量打满并全程 429
   * （边缘桥只能退避重试、队列堆积）。因此改为可配置（`INGEST_RATE_LIMIT` /
   * `INGEST_RATE_LIMIT_WINDOW_SEC`），默认值不变（不静默放宽安全姿态），
   * 由部署方按机群规模显式设定；启动日志打印生效值。
   */
  private static readonly DEFAULT_RATE_LIMIT = 100;
  private static readonly DEFAULT_WINDOW_SECONDS = 60;
  /**
   * 生效限流值：**实例化时**读取 env。
   *
   * 为什么不是模块作用域静态字段：静态字段在 import 期求值，于是
   *   1) 运行期/测试内改 env 不再生效（jest 里 `process.env.INGEST_RATE_LIMIT`
   *      形同虚设——本仓 ingest.guard.spec 的 100/min 用例正是这样被抓出来的）；
   *   2) 配置解析发生在 Nest 启动加载 env 之前，可能读到未加载的值。
   * 实例字段随 Guard 单例在应用启动时求值一次，行为等同"启动时快照生效值"。
   */
  private readonly rateLimit = readPositiveInt(
    process.env.INGEST_RATE_LIMIT,
    IngestGuard.DEFAULT_RATE_LIMIT,
  );
  private readonly windowSeconds = readPositiveInt(
    process.env.INGEST_RATE_LIMIT_WINDOW_SEC,
    IngestGuard.DEFAULT_WINDOW_SECONDS,
  );


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
      throw new HttpException(
        `Rate limit exceeded (${this.rateLimit} req/${this.windowSeconds}s)`,
        429,
      );
    }

    // 机器对机器租户上下文（R2-SOP-004：key 绑定优先，客户端自报仅在
    // key 绑定域内或 legacy 无绑定模式下接受）。
    const headerOrgId = (request.headers['x-org-id'] as string | undefined)?.trim();
    const fallbackOrgId = process.env.EWOH_INGEST_ORG_ID?.trim();
    let orgId: string;
    // 本次 key 的 org 绑定（`null` = legacy 无绑定模式，org 由客户端自报）。
    // 见下方 `ingestKeyBoundOrgId` 的用途说明。
    let ingestKeyBoundOrgId: string | null = null;
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
        ingestKeyBoundOrgId = matched.boundOrgId;
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
        /**
         * 本次请求所用 ingest key 的 **org 绑定**（`null` = legacy 无绑定模式，
         * org 由客户端自报）。
         *
         * 为什么要把它单独暴露出来（2026-09-13）：有些**写面**的成立与否取决于
         * "租户归属是不是凭证层给的"，而不是"客户端说它是哪个租户"。典型是
         * 设备执行事实上行（`device_receipt` 来源）——它的产出会决定执行回执能否
         * 成为**生产训练样本**，因此必须要求绑定 key，否则任何持无绑定 key 的一方
         * 都能声称任意租户并产出"看起来合法"的训练数据。
         * 本字段就是那条判据的载体，消费方（`DeviceExecutionReceiptService`）据它
         * fail-closed。
         */
        ingestKeyBoundOrgId?: string | null;
      };
    }).userContext = {
      userId: 'ingest',
      primaryOrgId: orgId,
      accessibleOrgIds: [orgId],
      isGlobalAdmin: false,
      ingestKeyBoundOrgId,
    };

    return true;
  }

  /**
   * 解析 key→org 绑定表（R2-SOP-004）。
   *
   * 解析规则与启动期门禁共用 `ingest-key-config.ts`（单一事实源）：
   *  1. INGEST_API_KEY_<ORG_ID>=<key>（env 扫描，后缀即 org id）；
   *  2. INGEST_API_KEYS / INGEST_API_KEY_MAP：JSON `{"<key>": "<orgId>"}`；
   *  3. legacy INGEST_API_KEY：配了 EWOH_INGEST_ORG_ID → 绑定该 org，
   *     否则无绑定（Map 值 null，走 legacy 自报路径）。
   * 进程内缓存解析结果；配置错误在此以 error 级日志暴露（启动门禁已在
   * production 拒绝非法配置，此处覆盖非 production 与运行期热改场景）。
   */
  private resolveKeyBindings(): Map<string, string | null> {
    if (this.keyBindings) return this.keyBindings;
    const { bindings, errors } = resolveIngestKeyConfiguration();
    for (const error of errors) this.logger.error(`接入密钥配置错误：${error}`);
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
      this.windowSeconds,
    );
    return count <= this.rateLimit;
  }
}
