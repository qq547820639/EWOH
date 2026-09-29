import {
  Controller,
  Get,
  Inject,
  Logger,
  Optional,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { sql } from 'drizzle-orm';
import { Public } from '../shared/public.decorator';
import { MetricsService } from '../metrics/metrics.service';
import { ReplanGuardStatusService } from './replan-guard-status.service';
// 必须是**值导入**：`import type` 会让 emitDecoratorMetadata 拿不到类引用，
// Nest 无法按类型解析这个 @Optional 构造参数（实测：注入成 undefined ⇒ 兜底开关下仍 503）。
import { RequestDatabaseContext } from '../../database/request-database-context';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Optional() private readonly metrics?: MetricsService,
    // P1-6（§六）：跨实例 replan 守卫降级状态（可选注入，readiness 上报 degraded reason）。
    @Optional() private readonly replanGuardStatus?: ReplanGuardStatusService,
    // CFG-01b（V65）：探活是**身份之前**的读（`@Public` ⇒ OrgContextInterceptor 不建事务），
    // 直接打注入句柄会在"请求上下文内无事务 store"时回落根句柄——
    // `EWOH_DB_REQUIRE_TX=1`（注释写着"生产建议开启"的那道租户隔离兜底）下一抛错，
    // 本方法就把它吞成 503：**开着推荐开关的应用永远无法通过就绪探针**。
    // 与 V61 修 login 503 同源同法：给它一个显式系统事务（`select 1` 本就跨租户）。
    @Optional() private readonly requestDatabaseContext?: RequestDatabaseContext,
  ) {}

  /**
   * 就绪探针的 DB 可达性检查：走显式系统事务，不依赖请求事务 store。
   * 上下文缺失时（旧装配/单测替身）退回原句柄，不新增失败模式。
   */
  private async probeDatabase(): Promise<void> {
    const run = async () => {
      const db = this.db as unknown as {
        execute: (query: unknown) => Promise<unknown>;
      };
      await db.execute(sql`select 1 as ready`);
    };
    if (typeof this.requestDatabaseContext?.systemTransaction === 'function') {
      await this.requestDatabaseContext.systemTransaction(run);
      return;
    }
    await run();
  }

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
      await this.probeDatabase();
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
    } catch (error) {
      // CFG-01b（V65）：原来这里是一个裸 `catch {}`——把"隔离兜底被触发"这类成因
      // 直接重写成"数据库不可用"，运维面看到的就是一个无解释的 503
      // （与 V61 修掉的 login 503 同一形状）。保留 503 语义，但成因必须留痕。
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.logger.error(`就绪探针数据库检查失败（含 EWOH_DB_REQUIRE_TX fail-closed）：${reason}`);
      this.metrics?.recordDbReady(false);
      if (!detailed) {
        throw new ServiceUnavailableException('Not ready');
      }
      throw new ServiceUnavailableException('Database is not ready');
    }
  }
}
