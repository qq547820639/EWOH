import {
  Controller,
  Get,
  Inject,
  Optional,
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

  @Public()
  @Get('ready')
  async ready() {
    try {
      await this.db.execute(sql`select 1 as ready`);
      this.metrics?.recordDbReady(true);
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
      throw new ServiceUnavailableException('Database is not ready');
    }
  }
}
