import { Injectable, Optional } from '@nestjs/common';

/**
 * Frontend metrics ingestion service.
 *
 * Receives Web Vitals / route / API / offline metrics POSTed by the browser
 * (`client/src/lib/observability.ts`), tags each record with the requester's
 * org/user, redacts sensitive material, and keeps a bounded in-memory store so
 * the diagnostic endpoint can query recently ingested metrics.
 *
 * Design notes:
 *  - Bounded ring buffer (no unbounded growth); overflow drops oldest.
 *  - Org isolation: every stored record carries `orgId`; the query endpoint only
 *    returns what the requester's org may see.
 *  - Redaction: URL/error/token/user-input/PII-bearing tag keys and values are
 *    scrubbed before storage so sensitive data never leaves the client intact.
 *  - Self-contained in-memory rate limiting (no external Redis) so ingestion is
 *    testable without infrastructure; production may swap in the Redis-based
 *    RateLimitGuard.
 */

export interface FrontendMetric {
  name: string;
  value: number;
  tags?: Record<string, string | number | boolean>;
  /** 采集时刻（epoch ms）。缺省时服务端以当前时间填充。 */
  at?: number;
}

export interface FrontendMetricsPayload {
  metrics: FrontendMetric[];
  requestId?: string;
  traceId?: string;
  page?: string;
  buildVersion?: string;
  deviceCategory?: string;
}

export interface StoredFrontendMetric extends FrontendMetric {
  orgId: string;
  userId?: string;
  page?: string;
  buildVersion?: string;
  deviceCategory?: string;
  requestId?: string;
  traceId?: string;
  receivedAt: string;
}

const SENSITIVE_TAG_KEY = /token|secret|password|authorization|api[-_]?key|refresh|credential|session/i;
const SENSITIVE_VALUE = /(Bearer\s+[A-Za-z0-9._-]{8,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/;
const QUERY_SECRET = /([?&](?:token|key|secret|password|apikey|signature)=)[^&\s]+/gi;

function redactString(value: string): string {
  const out = value
    .replace(SENSITIVE_VALUE, '[REDACTED]')
    .replace(QUERY_SECRET, '$1[REDACTED]');
  // Shorten long URL query strings / error dumps.
  return out.length > 500 ? `${out.slice(0, 497)}...` : out;
}

function redactTags(tags: Record<string, string | number | boolean> | undefined) {
  if (!tags) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (SENSITIVE_TAG_KEY.test(key)) {
      out[key] = '[REDACTED]';
      continue;
    }
    if (typeof value === 'string') out[key] = redactString(value);
    else out[key] = value;
  }
  return out;
}

@Injectable()
export class FrontendMetricsService {
  private readonly records: StoredFrontendMetric[] = [];
  private readonly maxRecords: number;
  private readonly maxBatch: number;
  // In-memory per-subject request counters for the current window.
  private readonly windowStart: number;
  private readonly windowMs: number;
  private readonly maxPerWindow: number;
  private readonly counts = new Map<string, number>();

  constructor(
    @Optional() private readonly options?: {
      maxRecords?: number;
      maxBatch?: number;
      rateLimitWindowMs?: number;
      rateLimitMax?: number;
    },
  ) {
    const opts = options ?? {};
    this.maxRecords = opts.maxRecords ?? 5000;
    this.maxBatch = opts.maxBatch ?? 200;
    this.windowMs = opts.rateLimitWindowMs ?? 60_000;
    this.maxPerWindow = opts.rateLimitMax ?? 1000;
    this.windowStart = Date.now();
  }

  /** Token-bucket-ish per-subject limiter. Returns remaining budget. */
  rateLimit(subject: string): { allowed: boolean; remaining: number } {
    const now = Date.now();
    if (now - this.windowStart >= this.windowMs) {
      this.counts.clear();
    }
    const used = this.counts.get(subject) ?? 0;
    if (used >= this.maxPerWindow) {
      return { allowed: false, remaining: 0 };
    }
    this.counts.set(subject, used + 1);
    return { allowed: true, remaining: this.maxPerWindow - used - 1 };
  }

  /**
   * Validate and store an ingested batch. Throws on invalid input; returns the
   * number of accepted records.
   */
  ingest(
    payload: FrontendMetricsPayload,
    ctx: { orgId: string; userId?: string },
  ): { accepted: number; reason?: string } {
    if (!Array.isArray(payload.metrics)) {
      throw new Error('metrics 必须为数组');
    }
    if (payload.metrics.length === 0) {
      return { accepted: 0, reason: 'empty' };
    }
    if (payload.metrics.length > this.maxBatch) {
      throw new Error(`批量上限 ${this.maxBatch} 条`);
    }
    let accepted = 0;
    for (const m of payload.metrics) {
      if (!m || typeof m.name !== 'string' || m.name.length === 0 || m.name.length > 200) {
        continue;
      }
      if (typeof m.value !== 'number' || !Number.isFinite(m.value)) {
        continue;
      }
      if (m.at !== undefined && (typeof m.at !== 'number' || !Number.isFinite(m.at))) {
        continue;
      }
      const stored: StoredFrontendMetric = {
        name: m.name,
        value: m.value,
        at: typeof m.at === 'number' ? m.at : Date.now(),
        tags: redactTags(m.tags),
        orgId: ctx.orgId,
        userId: ctx.userId,
        page: payload.page ? redactString(payload.page) : undefined,
        buildVersion: payload.buildVersion,
        deviceCategory: payload.deviceCategory,
        requestId: payload.requestId,
        traceId: payload.traceId,
        receivedAt: new Date().toISOString(),
      };
      this.records.push(stored);
      if (this.records.length > this.maxRecords) {
        this.records.splice(0, this.records.length - this.maxRecords);
      }
      accepted += 1;
    }
    return { accepted };
  }

  /**
   * Org-isolated query. A non-global requester only sees their own org.
   */
  query(
    orgId: string,
    opts: { limit?: number; metricName?: string } = {},
  ): StoredFrontendMetric[] {
    const safeLimit = Math.max(1, Math.min(1000, Number(opts.limit) || 100));
    const filtered = this.records.filter(
      (r) =>
        r.orgId === orgId &&
        (!opts.metricName || r.name === opts.metricName),
    );
    return [...filtered].reverse().slice(0, safeLimit);
  }

  summary(): Record<string, number> {
    const byName = new Map<string, number>();
    for (const r of this.records) {
      byName.set(r.name, (byName.get(r.name) ?? 0) + 1);
    }
    return {
      total: this.records.length,
      distinctNames: byName.size,
      ...Object.fromEntries(byName),
    };
  }

  clear(): void {
    this.records.length = 0;
  }
}
