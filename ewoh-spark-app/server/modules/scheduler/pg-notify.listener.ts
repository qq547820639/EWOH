import { Logger } from '@nestjs/common';
import postgres from 'postgres';
import type { SchedulerOutboxListener } from './scheduler-stream.service';

/** 与 db/migrations/standalone_024_scheduler_outbox_notify.sql 的 pg_notify 频道名一致。 */
export const SCHEDULER_OUTBOX_NOTIFY_CHANNEL = 'scheduler_outbox';

/** LISTEN 初连失败后的重试退避（cap）。 */
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 30_000;

/**
 * Postgres LISTEN 监听器（Task 6：Outbox → LISTEN/NOTIFY 低延迟 wake-up）。
 *
 * - 建立专用连接执行 `LISTEN scheduler_outbox`，收到通知即触发 onNotify（→ SchedulerStreamService.poll）；
 * - 只读优化：NOTIFY 不是唯一事实源，事件语义仍由 outbox 轮询/sequence/replay 保证；
 * - 连接失败/通知异常仅记日志（轮询主路径不受影响），初连失败按指数退避重试；
 * - 连接建立后由 postgres.js 的 listen 内建 onclose 自动重连并重新订阅。
 *
 * 注意：不阻塞 main 启动——subscribe() 立即返回，连接在后台异步建立；
 * SchedulerStreamService 仅在首个 SSE 订阅（start()）时才调用 subscribe()。
 *
 * 说明：本类由 scheduler.module 的 useFactory 按 SCHEDULER_STREAM_NOTIFY=1 条件手工构造，
 * 不参与 Nest DI 自动实例化，因此无需 @Injectable。
 */
export class PgNotifyListener implements SchedulerOutboxListener {
  private readonly logger = new Logger(PgNotifyListener.name);
  private closed = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private unlisten: (() => Promise<unknown>) | null = null;
  private client: ReturnType<typeof postgres> | null = null;

  constructor(
    private readonly databaseUrl: string,
    private readonly channel: string = SCHEDULER_OUTBOX_NOTIFY_CHANNEL,
  ) {}

  /** 订阅通知（异步建立连接，立即返回取消函数；失败自动退避重试直至取消）。 */
  subscribe(onNotify: () => void): () => void {
    void this.connect(onNotify, RETRY_BASE_MS);
    return () => {
      this.closed = true;
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      if (this.unlisten) {
        void this.unlisten().catch(() => undefined);
        this.unlisten = null;
      }
      if (this.client) {
        void this.client.end({ timeout: 0 }).catch(() => undefined);
        this.client = null;
      }
    };
  }

  private async connect(onNotify: () => void, retryDelayMs: number): Promise<void> {
    try {
      const client = postgres(this.databaseUrl, {
        max: 1,
        idle_timeout: 30_000,
        connect_timeout: 10,
        prepare: false,
        onnotice: () => undefined,
      });
      // postgres.js 的 listen 使用专用连接（max:1, idle_timeout:null），
      // 连接断开时内建 onclose 自动重连并重新订阅频道。
      const { unlisten } = await client.listen(this.channel, () => {
        try {
          onNotify();
        } catch (err) {
          // 通知回调抛错仅告警：轮询照常兜底，绝不因 LISTEN 异常影响事件流。
          this.logger.warn(
            'scheduler outbox notify callback failed; polling still covers wake-up',
            err instanceof Error ? err.stack : String(err),
          );
        }
      });
      if (this.closed) {
        void unlisten().catch(() => undefined);
        void client.end({ timeout: 0 }).catch(() => undefined);
        return;
      }
      this.client = client;
      this.unlisten = unlisten;
      this.logger.log(`LISTEN ${this.channel} established (scheduler outbox notify wake-up)`);
    } catch (err) {
      // 初连失败 → 降级纯轮询 + 退避重试（NOTIFY 只是优化，不阻塞不抛给调用方）。
      this.logger.warn(
        `LISTEN ${this.channel} failed; falling back to polling-only wake-up`,
        err instanceof Error ? err.stack : String(err),
      );
      if (!this.closed) {
        const nextDelay = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.connect(onNotify, nextDelay);
        }, retryDelayMs);
      }
    }
  }
}
