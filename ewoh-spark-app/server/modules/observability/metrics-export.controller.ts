import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { MetricsExportService } from './metrics-export.service';
import { EdgeMetricsService } from './edge-metrics.service';
import { Roles } from '../shared/roles.decorator';
import { IngestGuard } from '../ingest/ingest.guard';
import { Public } from '../shared/public.decorator';
import { UseGuards } from '@nestjs/common';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * 统一指标导出面（ADR-023 / NO-10b，§19 指标腿）。
 *
 *  - GET /api/observability/metrics         JSON：metrics + registryViolations
 *  - GET /api/observability/metrics/text    Prometheus text 兼容渲染
 *
 * 角色：global_admin/safety_admin（与 traces 一致）。
 */
@Controller('api/observability/metrics')
@Roles('global_admin', 'safety_admin')
export class MetricsExportController {
  constructor(
    private readonly metricsExport: MetricsExportService,
    private readonly edgeMetrics: EdgeMetricsService,
  ) {}

  @Get()
  snapshot(@Req() request: { userContext?: OrgContext }) {
    return this.metricsExport.snapshot(request.userContext?.primaryOrgId?.trim() || undefined);
  }

  @Get('text')
  text() {
    return this.metricsExport.renderPrometheus();
  }

  @Post('edge-metrics')
  @UseGuards(IngestGuard)
  // Machine-to-machine metrics uplink（ADR-028）：与 ingest 同通道鉴权。
  @Public()
  ingestEdgeMetrics(
    @Body() body: { metrics?: unknown[] },
    @Req() request: { userContext?: OrgContext },
  ) {
    const orgId = request.userContext?.primaryOrgId?.trim();
    if (!orgId) {
      return { accepted: 0, rejected: 0, violations: ['org:missing_org_context'], totalReceived: Array.isArray(body?.metrics) ? body.metrics.length : 0 };
    }
    return this.edgeMetrics.ingest(orgId, body?.metrics ?? []);
  }
}
