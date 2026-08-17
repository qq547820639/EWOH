import { Injectable, Optional } from '@nestjs/common';
import { validateMetricSample } from '@shared/metrics-registry';
import { MetricsService } from '../metrics/metrics.service';
import { SchedulerMetricsService } from '../scheduler/scheduler-metrics.service';
import { AgentMetricsService, type AgentMetricSample } from '../agent/agent-metrics.service';
import { EdgeMetricsService } from './edge-metrics.service';

export interface MetricSample {
  metricName: string;
  metricType: string;
  value: number;
  labels: Record<string, string>;
}

export interface MetricsExport {
  metrics: MetricSample[];
  registryViolations: string[];
}

/**
 * MetricsExportService（ADR-023 / NO-10b，§19 指标腿）：云侧统一指标导出面。
 *
 * - 组装真实来源：http/db 面 ← MetricsService；scheduler 面 ←
 *   SchedulerMetricsService（内联标签解析）；agent 面 ← AgentMetricsService；
 *   connector 面 ← EdgeMetricsService（ADR-028：边缘 Prometheus /metrics 经
 *   Edge→Cloud 上行落本租户快照注册表，命名收敛同一注册表——不伪造数值）；
 * - 每条样本经 validateMetricSample 契约校验（fail-closed）：未注册名/
 *   类型失配/未知标签/负数 → registryViolations 显式列出（§33 unknown
 *   不当 normal——绝不舍弃也不并入正常）；legacy 指标名（未入 v1 注册表）
 *   同样以 violation 暴露，后续轮次迁移；
 * - 导出 = JSON（metrics + violations）+ Prometheus text 兼容渲染。
 */
@Injectable()
export class MetricsExportService {
  constructor(
    private readonly httpMetrics: MetricsService,
    @Optional() private readonly schedulerMetrics?: SchedulerMetricsService,
    @Optional() private readonly agentMetrics?: AgentMetricsService,
    @Optional() private readonly edgeMetrics?: EdgeMetricsService,
  ) {}

  /** orgId 缺省 = 全部租户边缘样本（global_admin 全节点视图）。 */
  snapshot(orgId?: string): MetricsExport {
    const samples: MetricSample[] = [];
    const violations: string[] = [];

    const push = (sample: MetricSample): void => {
      const errors = validateMetricSample(sample);
      if (errors.length === 0) {
        samples.push(sample);
      } else {
        violations.push(`${sample.metricName}:${errors.join(',')}`);
      }
    };

    // ── http/db 面（MetricsService 真实计数） ─────────────────────────────
    const http = this.httpMetrics.snapshot();
    for (const [key, count] of Object.entries(http.requests)) {
      const [method, route, status] = key.split(' ');
      push({
        metricName: 'http_requests_total',
        metricType: 'counter',
        value: count,
        labels: { method: method ?? 'unknown', route: route ?? 'unknown', status: status ?? 'unknown' },
      });
    }
    push({ metricName: 'http_active_requests', metricType: 'gauge', value: http.activeRequests, labels: {} });
    push({ metricName: 'db_ready_checks_total', metricType: 'counter', value: http.dbReady.ok, labels: { result: 'ok' } });
    push({ metricName: 'db_ready_checks_total', metricType: 'counter', value: http.dbReady.failed, labels: { result: 'failed' } });

    // ── scheduler 面（内联标签解析 + gauge/histogram） ────────────────────
    if (this.schedulerMetrics) {
      const raw = this.schedulerMetrics.snapshot();
      for (const [key, value] of Object.entries(raw)) {
        const parsed = this.parseInlineLabels(key);
        if (!parsed) {
          violations.push(`${key}:unparseable`);
          continue;
        }
        let { name, labels } = parsed;
        let type = 'counter';
        if (name === 'scheduler_feasible_ratio') type = 'gauge';
        if (name.endsWith('_bucket')) {
          name = name.slice(0, -'_bucket'.length);
          type = 'histogram';
        }
        push({ metricName: name, metricType: type, value, labels });
      }
    }

    // ── agent 面（AgentMetricsService 注册表命名样本） ────────────────────
    if (this.agentMetrics) {
      for (const s of this.agentMetrics.snapshot()) {
        push({ ...s });
      }
    }

    // connector 面（ADR-028）：边缘上行样本 + 上行健康计数（无上行 = 零样本
    // 显式，不伪造；事实源 = 边缘 /metrics 经 EdgeMetricsService 落账）。
    if (this.edgeMetrics) {
      for (const s of this.edgeMetrics.getConnectorSamples()) {
        push({ ...s });
      }
      for (const s of this.edgeMetrics.getSamples(orgId)) {
        push({ ...s });
      }
    }

    return { metrics: samples, registryViolations: violations };
  }

  /**
   * R2-SNZ-007：renderPrometheus 透传 orgId（原先调 snapshot() 无参 =
   * 全租户边缘样本，text 端点绕过租户作用域）。
   */
  renderPrometheus(orgId?: string): string {
    const { metrics, registryViolations } = this.snapshot(orgId);
    const escapeLabel = (value: string): string =>
      value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const lines: string[] = [];
    for (const sample of metrics) {
      const labelText = Object.entries(sample.labels)
        .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
        .join(',');
      lines.push(
        `${sample.metricName}${labelText ? `{${labelText}}` : ''} ${sample.value}`,
      );
    }
    for (const violation of registryViolations) {
      lines.push(`# registry_violation ${violation}`);
    }
    return `${lines.join('\n')}\n`;
  }

  /** "name{key="value",...}" → { name, labels }；无标签形如 "name"。 */
  private parseInlineLabels(key: string): { name: string; labels: Record<string, string> } | null {
    const brace = key.indexOf('{');
    if (brace === -1) return { name: key, labels: {} };
    if (!key.endsWith('}')) return null;
    const name = key.slice(0, brace);
    const inner = key.slice(brace + 1, -1);
    const labels: Record<string, string> = {};
    for (const part of inner.split(',')) {
      const eq = part.indexOf('=');
      if (eq === -1) return null;
      const labelKey = part.slice(0, eq).trim();
      const rawValue = part.slice(eq + 1).trim();
      if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
        labels[labelKey] = rawValue.slice(1, -1);
      } else {
        labels[labelKey] = rawValue;
      }
    }
    return { name, labels };
  }
}

/** 类型守卫：AgentMetricSample 与 MetricSample 兼容（counter 恒定）。 */
export type { AgentMetricSample };
