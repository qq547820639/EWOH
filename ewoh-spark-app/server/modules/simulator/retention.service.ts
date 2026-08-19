import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import postgres from 'postgres';

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
 * 连接说明（2026-08-19 修复）：注入的 DRIZZLE_DATABASE 经 RequestDatabaseContext
 * proxy——后台定时器无请求上下文时回落 root 句柄，而 root 句柄（DATABASE_URL）
 * 是 ewoh_api 用户（RLS 生效），无 GUC 时被租户策略过滤 → 读空删空（静默失效）。
 * 本服务改用独立 owner 连接（EWOH_DATABASE_URL，表 owner 默认绕过 RLS）——
 * 系统级清理必须跨租户可见。
 *
 * 实现：分批删除——PG 的 DELETE 不支持 LIMIT 子句，用
 * 「SELECT id LIMIT 取批 → DELETE WHERE id IN」两段式分批（标准模式）。
 * 表名/列名均为白名单常量；cutoff 为 ISO 时间戳，内联安全。
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private timer: NodeJS.Timeout | null = null;
  /** 独立系统级连接（优先 owner 串绕 RLS；缺省回落 DATABASE_URL 尽力而为）。 */
  private readonly ownerClient: postgres.Sql | null;

  private static readonly CLEAN_INTERVAL_MS = 60 * 60 * 1000; // 每小时
  private static readonly BATCH = 5000;

  constructor() {
    const url =
      process.env.EWOH_DATABASE_URL || process.env.DATABASE_URL || '';
    this.ownerClient = url
      ? postgres(url, { max: 2, idle_timeout: 60_000, prepare: false })
      : null;
  }

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
    if (!this.ownerClient) {
      this.logger.warn('retention skipped: no EWOH_DATABASE_URL / DATABASE_URL');
      return;
    }
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
      for (;;) {
        const pending = await this.ownerClient.unsafe<
          Array<{ id: string }>
        >(
          `SELECT id FROM ${job.table}
           WHERE ${job.tsColumn} < '${cutoff}'::timestamptz
           LIMIT ${RetentionService.BATCH}`,
        );
        if (pending.length === 0) break;
        const idList = pending.map((row) => `'${row.id}'`).join(',');
        await this.ownerClient.unsafe(
          `DELETE FROM ${job.table} WHERE id IN (${idList})`,
        );
        total += pending.length;
      }
      if (total > 0) {
        this.logger.log(
          `retention: ${job.table} cleaned ${total} rows (keep ${job.keepMs / 3_600_000}h)`,
        );
      }
    }
  }
}
