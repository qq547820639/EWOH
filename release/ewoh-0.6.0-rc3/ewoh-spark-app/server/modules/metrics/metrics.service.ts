import { Injectable } from '@nestjs/common';

@Injectable()
export class MetricsService {
  private readonly requests = new Map<string, number>();
  private readonly startedAt = Date.now();
  private activeRequests = 0;
  private dbReadyChecks = {
    ok: 0,
    failed: 0,
    lastOkAt: null as string | null,
  };

  beginRequest(): void {
    this.activeRequests += 1;
  }

  endRequest(method: string, route: string, status: number): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    const key = `${method} ${route} ${status}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
  }

  recordDbReady(ok: boolean): void {
    if (ok) {
      this.dbReadyChecks.ok += 1;
      this.dbReadyChecks.lastOkAt = new Date().toISOString();
    } else {
      this.dbReadyChecks.failed += 1;
    }
  }

  resourceAttributes() {
    const env = (key: string, fallback: string) => {
      const value = process.env[key]?.trim();
      return value && value.length > 0 ? value : fallback;
    };
    return {
      factoryId: env('EWOH_FACTORY_ID', 'unknown'),
      factoryName: env('EWOH_FACTORY_NAME', 'unknown'),
      upgradeRing: env('EWOH_FACTORY_UPGRADE_RING', 'unknown'),
      releaseVersion: env('EWOH_RELEASE_VERSION', '0.6.0-rc3'),
      region: env('EWOH_REGION', 'unknown'),
    };
  }

  private escapeLabel(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');
  }

  snapshot() {
    return {
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      activeRequests: this.activeRequests,
      requests: Object.fromEntries(this.requests),
      dbReady: { ...this.dbReadyChecks },
    };
  }

  renderPrometheus(): string {
    const snapshot = this.snapshot();
    const resource = this.resourceAttributes();
    const lines: string[] = [];
    lines.push(
      '# HELP ewoh_http_requests_total Total HTTP requests by method, route, and status',
      '# TYPE ewoh_http_requests_total counter',
    );
    for (const [key, count] of [...this.requests.entries()].sort()) {
      const [method, route, status] = key.split(' ');
      lines.push(
        `ewoh_http_requests_total{method="${method}",route="${route}",status="${status}"} ${count}`,
      );
    }
    lines.push(
      '# HELP ewoh_process_uptime_seconds Process uptime in seconds',
      '# TYPE ewoh_process_uptime_seconds gauge',
      `ewoh_process_uptime_seconds ${snapshot.uptimeSeconds}`,
      '# HELP ewoh_http_active_requests Currently active HTTP requests',
      '# TYPE ewoh_http_active_requests gauge',
      `ewoh_http_active_requests ${snapshot.activeRequests}`,
      '# HELP ewoh_db_ready_checks_total Database readiness check results',
      '# TYPE ewoh_db_ready_checks_total counter',
      `ewoh_db_ready_checks_total{result="ok"} ${snapshot.dbReady.ok}`,
      `ewoh_db_ready_checks_total{result="failed"} ${snapshot.dbReady.failed}`,
      '# HELP ewoh_resource_info EWOH resource attributes',
      '# TYPE ewoh_resource_info gauge',
      `ewoh_resource_info{factory_id="${this.escapeLabel(resource.factoryId)}",factory_name="${this.escapeLabel(resource.factoryName)}",upgrade_ring="${this.escapeLabel(resource.upgradeRing)}",release_version="${this.escapeLabel(resource.releaseVersion)}",region="${this.escapeLabel(resource.region)}"} 1`,
    );
    return `${lines.join('\n')}\n`;
  }
}
