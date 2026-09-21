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
  /** 独立系统级连接。缺少显式 owner 串时必须显式跳过，不能用运行时角色静默读空。 */
  private readonly ownerClient: postgres.Sql | null;

  private static readonly CLEAN_INTERVAL_MS = 60 * 60 * 1000; // 每小时
  private static readonly BATCH = 5000;
  /** 模拟告警 open 自动过期时长（真实上报事件不受影响）。 */
  private static readonly SIM_EVENT_EXPIRY_MS = 2 * 3_600_000;

  constructor() {
    // The owner role bypasses RLS for cross-tenant retention. Falling back to the
    // runtime role would look like success while RLS makes every cleanup read zero
    // rows. Keep this fail-closed and expose the configuration gap as a warning.
    const url = process.env.EWOH_DATABASE_URL || '';
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

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Clean stops with the app; its dedicated owner pool must stop too so
    // embedded E2E apps and graceful shutdown do not leak PostgreSQL sockets.
    if (this.ownerClient) {
      await this.ownerClient.end({ timeout: 5 }).catch(() => undefined);
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
      // 快照表（2026-08-19 续）：snapshot_json 单行可达数十 MB（事件全量时代
      // 遗留，实测 21MB/行）——conflicts 的 stale plan 检查全量读取曾拖垮
      // 平台。48h 保留覆盖活跃方案引用窗口，历史快照归零。
      { table: 'ewoh_world_state_snapshot', tsColumn: 'created_at', keepMs: 48 * 3_600_000 },
    ];
    for (const job of jobs) {
      const cutoff = new Date(now - job.keepMs).toISOString();
      let total = 0;
      for (;;) {
        const pending = await this.ownerClient.unsafe<Array<{ id: string }>>(
          `SELECT id FROM ${job.table}
           WHERE ${job.tsColumn} < $1::timestamptz
           LIMIT $2`,
          [cutoff, RetentionService.BATCH],
        );
        if (pending.length === 0) break;
        const ids = pending.map((row) => row.id);
        await this.ownerClient.unsafe(
          `DELETE FROM ${job.table} WHERE id = ANY($1)`,
          [ids],
        );
        total += pending.length;
      }
      if (total > 0) {
        this.logger.log(
          `retention: ${job.table} cleaned ${total} rows (keep ${job.keepMs / 3_600_000}h)`,
        );
      }
    }
    await this.expireStaleSimulatedEvents(now);
  }

  /**
   * 模拟告警自动过期（2026-08-19 平台加载故障治本）。
   *
   * SimulatorService 持续生成告警（WorkerHighLoad/低电量/离线等），而演示/
   * 生产环境无人逐条处理 → status 永远停在 'open'，36h 实测累积 6.3 万条。
   * collectState（世界快照）全量消费 open 事件，曾把 conflicts 接口拖到
   * 104s、全平台 15s 超时。语义上超过 2h 无人处理的模拟告警也不应继续
   * 触发安全封锁/事件影响——分批置为 'expired'（不删除，7d 行留存档）。
   *
   * 仅限 source_type='simulated'（真实上报事件保留人工处置语义，不自动关闭）。
   */
  private async expireStaleSimulatedEvents(now: number): Promise<void> {
    if (!this.ownerClient) return;
    const cutoff = new Date(
      now - RetentionService.SIM_EVENT_EXPIRY_MS,
    ).toISOString();
    let total = 0;
    for (;;) {
      const pending = await this.ownerClient.unsafe<Array<{ id: string }>>(
        `SELECT id FROM ewoh_event
         WHERE status = 'open'
           AND source_type = 'simulated'
           AND created_at < $1::timestamptz
         LIMIT $2`,
        [cutoff, RetentionService.BATCH],
      );
      if (pending.length === 0) break;
      const ids = pending.map((row) => row.id);
      await this.ownerClient.unsafe(
        `UPDATE ewoh_event
         SET status = 'expired', _updated_at = now()
         WHERE id = ANY($1)`,
        [ids],
      );
      total += pending.length;
    }
    if (total > 0) {
      this.logger.log(
        `retention: expired ${total} stale simulated events (open > ${RetentionService.SIM_EVENT_EXPIRY_MS / 3_600_000}h)`,
      );
    }
  }
}
