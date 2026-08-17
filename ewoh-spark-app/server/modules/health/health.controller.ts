import {
  Controller,
  Get,
  Inject,
  Optional,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { sql } from 'drizzle-orm';
import { Public } from '../shared/public.decorator';
import { MetricsService } from '../metrics/metrics.service';
import { ReplanGuardStatusService } from './replan-guard-status.service';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Optional() private readonly metrics?: MetricsService,
    // P1-6（§六）：跨实例 replan 守卫降级状态（可选注入，readiness 上报 degraded reason）。
    @Optional() private readonly replanGuardStatus?: ReplanGuardStatusService,
  ) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'ok', service: 'ewoh-api' };
  }

  /**
   * NEST-437：匿名探活收敛——K8s/CI 探针（无凭证）仍可探测 DB 可达性并
   * 获得 {status} 结论，但不再暴露 checks 内部细节（replanGuard 降级原因、
   * 调度器拓扑）；带凭证请求返回完整 checks。
   */
  @Public()
  @Get('ready')
  async ready(
    @Req() request?: { userContext?: unknown; headers?: { authorization?: string } },
  ) {
    const detailed = Boolean(
      request?.userContext ?? request?.headers?.authorization,
    );
    try {
      await this.db.execute(sql`select 1 as ready`);
      this.metrics?.recordDbReady(true);
      if (!detailed) {
        return { status: 'ok', service: 'ewoh-api' };
      }
      const checks: Record<string, unknown> = { database: 'ok' };
      if (this.replanGuardStatus) {
        const guard = this.replanGuardStatus.getStatus();
        if (guard.state === 'degraded') {
          checks.scheduler = {
            replanGuard: 'degraded',
            reason: guard.reason ?? 'cross-instance replan guard degraded',
            lastDegradationAt: guard.lastDegradationAt,
          };
          return { status: 'degraded', service: 'ewoh-api', checks };
        }
        checks.scheduler = { replanGuard: 'ok' };
      }
      return { status: 'ok', service: 'ewoh-api', checks };
    } catch {
      this.metrics?.recordDbReady(false);
      if (!detailed) {
        throw new ServiceUnavailableException('Not ready');
      }
      throw new ServiceUnavailableException('Database is not ready');
    }
  }
}
