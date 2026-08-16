import { Injectable } from '@nestjs/common';

export interface AgentMetricSample {
  metricName: string;
  metricType: 'counter';
  value: number;
  labels: Record<string, string>;
}

/**
 * AgentMetricsService（ADR-023 / NO-10b）：注册表命名 Agent 指标 counter。
 * 埋点在 AgentService 真实调用点（注册/提议/执行/拒绝/委托/审批解析）；
 * 观测旁路语义——指标失败绝不阻断主流程（调用方不依赖其返回值）。
 */
@Injectable()
export class AgentMetricsService {
  private readonly counters = new Map<string, number>();

  private inc(metricName: string, labels: Record<string, string>, by = 1): void {
    const key = JSON.stringify({ metricName, labels });
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  recordManifestRegistered(role: string): void {
    this.inc('agent_manifest_registered_total', { role });
  }

  recordCommand(
    outcome: 'proposed' | 'executed' | 'rejected' | 'delegated',
    role: string,
    command: string,
  ): void {
    this.inc(`agent_command_${outcome}_total`, { role, command });
  }

  recordApprovalResolved(outcome: 'approved' | 'rejected'): void {
    this.inc('agent_approval_resolved_total', { outcome });
  }

  /** 注册表命名样本快照（供统一导出面组装）。 */
  snapshot(): AgentMetricSample[] {
    const samples: AgentMetricSample[] = [];
    for (const [key, value] of this.counters.entries()) {
      const parsed = JSON.parse(key) as { metricName: string; labels: Record<string, string> };
      samples.push({
        metricName: parsed.metricName,
        metricType: 'counter',
        value,
        labels: parsed.labels,
      });
    }
    return samples.sort((a, b) => (a.metricName < b.metricName ? -1 : 1));
  }
}
