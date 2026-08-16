import { Injectable, Logger } from '@nestjs/common';
import { validateMetricSample } from '@shared/metrics-registry';

export interface EdgeSample {
  metricName: string;
  metricType: string;
  value: number;
  labels: Record<string, string>;
}

export interface EdgeMetricsIngestResult {
  accepted: number;
  rejected: number;
  violations: string[];
  totalReceived: number;
}

interface StoredSample {
  sample: EdgeSample;
  receivedAt: number;
}

/**
 * EdgeMetricsService（ADR-028 / NO-12d，§19 指标腿）：边缘指标快照接收面。
 *
 * - POST /api/observability/edge-metrics 的权威写路径：逐条
 *   validateMetricSample 契约校验（fail-closed——未注册名/类型失配/未知
 *   标签/负数 = violation 显式列出，绝不静默并入正常，§33）；
 * - 存储 = 进程内 per-org 有界快照注册表（latest-wins：同
 *   (metricName,labels) upsert；TTL 5 分钟无新样本即过期移除——指标是
 *   周期快照非事实，过期即不可信），org 边界显式（他租户样本绝不可见）；
 * - 上行健康经 connector_* 家族计数暴露（connector_id=edge_id、
 *   connector_type=metrics_uplink）：samples_total 累计、error_total 累计、
 *   active gauge = 最近一次上行成功的 edge 集合；
 * - 无持久化：边缘重启/云重启后样本随下一周期自然重建（最新快照语义）。
 */
@Injectable()
export class EdgeMetricsService {
  private readonly logger = new Logger(EdgeMetricsService.name);
  private readonly byOrg = new Map<string, Map<string, StoredSample>>();
  private readonly lastSeen = new Map<string, { edgeId: string; ts: number; ok: boolean }>();
  private readonly edgeCounters = new Map<string, { samples: number; errors: number }>();

  private static readonly TTL_MS = 5 * 60 * 1000;
  private static readonly MAX_SAMPLES_PER_ORG = 10000;

  ingest(orgId: string, metrics: unknown[]): EdgeMetricsIngestResult {
    const violations: string[] = [];
    let accepted = 0;
    if (!orgId?.trim()) {
      violations.push('org:missing_org_context');
      return { accepted: 0, rejected: Array.isArray(metrics) ? metrics.length : 0, violations, totalReceived: Array.isArray(metrics) ? metrics.length : 0 };
    }
    if (!Array.isArray(metrics)) {
      return { accepted: 0, rejected: 0, violations: ['metrics:not_array'], totalReceived: 0 };
    }
    const now = Date.now();
    const store = this.storeFor(orgId);
    this.sweep(store, now);
    let rejected = 0;
    for (const raw of metrics) {
      if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
        rejected += 1;
        violations.push('sample:not_object');
        continue;
      }
      const r = raw as Record<string, unknown>;
      const sample: Record<string, unknown> = {
        metricName: String(r.metricName ?? ''),
        metricType: String(r.metricType ?? ''),
        value: typeof r.value === 'number' ? r.value : Number.NaN,
        labels: (r.labels ?? {}) as Record<string, string>,
      };
      const errors = validateMetricSample(sample);
      if (errors.length > 0) {
        rejected += 1;
        violations.push(`${sample.metricName}:${errors.join(',')}`);
        continue;
      }
      const labels = sample.labels as Record<string, string>;
      const key = this.keyOf(String(sample.metricName), labels);
      store.set(key, { sample: sample as unknown as EdgeSample, receivedAt: now });
      const edgeId = labels?.edge_id ?? 'unknown';
      const counter = this.edgeCounters.get(edgeId) ?? { samples: 0, errors: 0 };
      counter.samples += 1;
      this.edgeCounters.set(edgeId, counter);
      this.lastSeen.set(edgeId, { edgeId, ts: now, ok: true });
      accepted += 1;
      if (store.size > EdgeMetricsService.MAX_SAMPLES_PER_ORG) {
        this.sweep(store, now);
      }
    }
    if (violations.length > 0) {
      // 违规批次内显式计数 error（上行健康面；有效样本仍正常并入）。
      // active gauge 语义 = 该 edge 最近一次批次已被接收（HTTP 失败不会到达
      // 本服务——传输层失败由边缘侧 stats 计数）。
      const edgeId = this.inferEdgeId(metrics);
      if (edgeId) {
        const counter = this.edgeCounters.get(edgeId) ?? { samples: 0, errors: 0 };
        counter.errors += 1;
        this.edgeCounters.set(edgeId, counter);
        this.lastSeen.set(edgeId, { edgeId, ts: now, ok: true });
      }
    }
    this.logger.log(`edge metrics ingest org=${orgId} accepted=${accepted} rejected=${rejected} violations=${violations.length}`);
    return { accepted, rejected, violations, totalReceived: metrics.length };
  }

  /** 导出面：orgId 缺省 = 全部租户（global_admin 全节点视图）；否则仅该租户。 */
  getSamples(orgId?: string): EdgeSample[] {
    const now = Date.now();
    const out: EdgeSample[] = [];
    const orgs = orgId ? [orgId] : [...this.byOrg.keys()];
    for (const org of orgs) {
      const store = this.byOrg.get(org);
      if (!store) continue;
      this.sweep(store, now);
      for (const { sample } of store.values()) out.push(sample);
    }
    return out;
  }

  /** 上行健康面（connector_* 家族样本，供 MetricsExportService 合并）。 */
  getConnectorSamples(): EdgeSample[] {
    const out: EdgeSample[] = [];
    for (const [edgeId, counter] of this.edgeCounters) {
      out.push({
        metricName: 'connector_telemetry_samples_total',
        metricType: 'counter',
        value: counter.samples,
        labels: { connector_id: edgeId, connector_type: 'metrics_uplink' },
      });
      out.push({
        metricName: 'connector_error_total',
        metricType: 'counter',
        value: counter.errors,
        labels: { connector_id: edgeId, connector_type: 'metrics_uplink' },
      });
    }
    // active gauge：每个 edge 独立一条（connector_active_total labelKeys=[connector_type]）
    for (const edgeId of new Set([...this.lastSeen.values()].filter((s) => s.ok).map((s) => s.edgeId))) {
      out.push({
        metricName: 'connector_active_total',
        metricType: 'gauge',
        value: 1,
        labels: { connector_type: 'metrics_uplink', connector_id: edgeId },
      });
    }
    return out;
  }

  private storeFor(orgId: string): Map<string, StoredSample> {
    let store = this.byOrg.get(orgId);
    if (!store) {
      store = new Map();
      this.byOrg.set(orgId, store);
    }
    return store;
  }

  private sweep(store: Map<string, StoredSample>, now: number): void {
    for (const [key, entry] of store) {
      if (now - entry.receivedAt > EdgeMetricsService.TTL_MS) store.delete(key);
    }
  }

  private keyOf(metricName: string, labels: Record<string, string>): string {
    const labelText = Object.entries(labels ?? {})
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    return `${metricName}{${labelText}}`;
  }

  private inferEdgeId(metrics: unknown[]): string | null {
    for (const raw of metrics) {
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const labels = (raw as Record<string, unknown>).labels as Record<string, string> | undefined;
        if (labels?.edge_id) return labels.edge_id;
      }
    }
    return null;
  }
}
