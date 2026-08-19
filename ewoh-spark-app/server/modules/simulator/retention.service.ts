import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { sql } from 'drizzle-orm';

/**
 * 数据保留策略（2026-08-19 数据增长治理）。
 *
 * SimulatorService 降频（10s tick）后仍持续产生位置帧/遥测；本服务每小时
 * 分批清理超期数据，封顶表体积——演示环境只需近期数据，历史统计走 KPI 聚合表。
 *
 * 保留窗口：
 * - ewoh_world_state：位置帧，保留 24h（世界最新状态实时读，历史帧无消费方）
 * - ewoh_telemetry：遥测，保留 24h（AI 上下文/仪表盘均只查近 1h 窗口）
 * - ewoh_event / ewoh_event_chain：事件链，保留 7d（事件是业务语义，保留稍久）
 * - ewoh_trace_span：由 tracing.service 的 500 条环形缓冲管理，不在此清理
 *
 * 实现：分批 DELETE（每批 ≤BATCH）避免长事务/大锁；失败留痕不阻断后续批次。
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private timer: NodeJS.Timeout | null = null;

  private static readonly CLEAN_INTERVAL_MS = 60 * 60 * 1000; // 每小时
  private static readonly BATCH = 5000;

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  onModuleInit(): void {
    // 启动后先执行一次（清存量），再按小时周期清理。
    void this.cleanOnce().catch((error: unknown) => {
      this.logger.error(`retention bootstrap clean failed: ${String(error)}`);
    });
    this.timer = setInterval(() => {
      void this.cleanOnce().catch((error: unknown) => {
        this.logger.error(`retention clean failed: ${String(error)}`);
      });
    }, RetentionService.CLEAN_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async cleanOnce(): Promise<void> {
    const now = Date.now();
    const jobs: Array<{ table: string; tsColumn: string; keepMs: number }> = [
      { table: 'ewoh_world_state', tsColumn: 'ts', keepMs: 24 * 3_600_000 },
      { table: 'ewoh_telemetry', tsColumn: 'ts', keepMs: 24 * 3_600_000 },
      { table: 'ewoh_event', tsColumn: 'created_at', keepMs: 7 * 24 * 3_600_000 },
      { table: 'ewoh_event_chain', tsColumn: 'created_at', keepMs: 7 * 24 * 3_600_000 },
    ];
    for (const job of jobs) {
      const cutoff = new Date(now - job.keepMs).toISOString();
      let total = 0;
      // 分批删除：drizzle 0.45 execute 返回 RowList（数组），用长度判批次边界。
      for (;;) {
        const rows = (await this.db.execute(
          sql`DELETE FROM ${sql.raw(job.table)}
              WHERE ${sql.raw(job.tsColumn)} < ${cutoff}::timestamptz
              RETURNING id
              LIMIT ${RetentionService.BATCH}`,
        )) as unknown as Array<{ id?: unknown }>;
        const n = rows.length;
        total += n;
        if (n < RetentionService.BATCH) break;
      }
      if (total > 0) {
        this.logger.log(
          `retention: ${job.table} cleaned ${total} rows (keep ${job.keepMs / 3_600_000}h)`,
        );
      }
    }
  }
}
