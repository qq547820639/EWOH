import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import type { SchedulingEvent, OutboxEvent } from '@shared/api.interface';
import { OutboxService } from './outbox.service';

const POLL_INTERVAL_MS = 2_000;
const POLL_BATCH = 500;

/**
 * Outbox 通知监听器（Task 6：LISTEN/NOTIFY 低延迟 wake-up）。
 * - 只读优化：收到通知仅触发一次 poll，事件语义仍由 outbox 轮询/sequence/replay 保证；
 * - listener 任何抛错只记告警，绝不中断 2s 轮询主路径。
 */
export interface SchedulerOutboxListener {
  /** 订阅通知，返回取消订阅函数；建立失败允许抛出（调用方降级为纯轮询）。 */
  subscribe(onNotify: () => void): () => void;
}

/** notifyListener 注入 token：scheduler.module 仅在 SCHEDULER_STREAM_NOTIFY=1 时提供。 */
export const SCHEDULER_STREAM_NOTIFY_LISTENER = 'SCHEDULER_STREAM_NOTIFY_LISTENER';

/** SSE 重放结果：返回缺失事件，或标记需要重新同步。 */
export interface ReplayResult {
  events: SchedulingEvent[];
  /** true 表示客户端需放弃增量、拉取最新 snapshot 后重新订阅。 */
  resyncNeeded: boolean;
  /** 是否检测到 sequence 缺口（事件被裁剪/客户端超前）。 */
  gap: boolean;
  /** 服务器当前最大 sequence。 */
  currentSequence: number;
}

/**
 * 调度实时事件流服务（SSE 基础）：轮询 outbox，将新事件推送到 Subject，
 * 并支持 afterSequence/Last-Event-ID 重放、sequence 缺口检测与幂等去重。
 * 不做完整 WebSocket，仅提供可订阅的 Observable 事件源 + 重放查询。
 */
@Injectable()
export class SchedulerStreamService implements OnModuleDestroy {
  private readonly logger = new Logger(SchedulerStreamService.name);
  private readonly subject = new Subject<SchedulingEvent>();
  private lastSequence = 0;
  /** v0.7 Batch5.2：去重 Set 有界化（LRU 上限），防止长期运行内存无界增长。 */
  private readonly seenEventIds = new Set<string>();
  private static readonly SEEN_CAP = 5000;
  private timer: NodeJS.Timeout | null = null;
  /** Task 6：NOTIFY wake-up 订阅的取消函数（仅在提供 notifyListener 时非空）。 */
  private notifyUnsubscribe: (() => void) | null = null;

  /**
   * 保持既有构造签名向后兼容：`new SchedulerStreamService(outboxService)` 依然成立
   * （notifyListener 可选，缺省 undefined = 纯轮询，现有 spec 零改动）。
   * Nest DI 下 @Optional 保证 token 未提供（SCHEDULER_STREAM_NOTIFY != 1）时注入 undefined。
   */
  constructor(
    private readonly outboxService: OutboxService,
    @Optional() @Inject(SCHEDULER_STREAM_NOTIFY_LISTENER)
    private readonly notifyListener?: SchedulerOutboxListener,
  ) {}

  /** 记录已推送事件 id（有界去重：超上限淘汰最老一半）。 */
  private rememberEventId(id: string): void {
    this.seenEventIds.add(id);
    if (this.seenEventIds.size > SchedulerStreamService.SEEN_CAP) {
      // 防无界增长：清空最老一半（Set 保持插入序，近似 LRU）。
      const drop = Math.floor(this.seenEventIds.size / 2);
      let i = 0;
      for (const oldId of this.seenEventIds) {
        if (i++ >= drop) break;
        this.seenEventIds.delete(oldId);
      }
    }
  }

  /** 读取最近 limit 条事件并映射为 SchedulingEvent（可选 orgId 过滤：null=全局事件+该 org）。 */
  async snapshot(limit: number, orgId?: string | null): Promise<SchedulingEvent[]> {
    const events = await this.outboxService.listLatest(limit);
    return events
      .map((e) => this.toEvent(e))
      .filter((e) => (orgId ? e.orgId == null || e.orgId === orgId : true));
  }

  /**
   * 按 sinceSequence 重放缺失事件（等价于 SSE 的 Last-Event-ID / afterSequence）。
   * - sinceSequence 超前于服务器可用事件 → 返回 RESYNC_NEEDED（客户端应重新拉取快照）。
   * - 检测到 sequence 缺口（事件被裁剪）→ 返回 RESYNC_NEEDED。
   * - 正常则返回增量事件（按 sequence 升序，天然可据此补续）。
   */
  async replaySince(
    sinceSequence: number,
    lastEventId?: number,
    orgId?: string | null,
  ): Promise<ReplayResult> {
    const latest = await this.outboxService.latestSequence();
    const base = Math.max(sinceSequence, 0);

    // 客户端已超前于服务器 → 状态不一致，必须重新同步。
    if (base > latest) {
      return { events: [], resyncNeeded: true, gap: true, currentSequence: latest };
    }

    const rows = await this.outboxService.listSince(base);

    // 缺口判定：非全量请求下，回放首条 sequence 必须严格等于 base+1，
    // 否则说明中间事件被裁剪/丢失，增量无法安全续接。
    const gap = base > 0 && rows.length > 0 && rows[0].sequence > base + 1;
    if (gap) {
      return { events: [], resyncNeeded: true, gap: true, currentSequence: latest };
    }

    let events = rows.map((e) => this.toEvent(e));
    // P4-SSE：组织隔离——非全局事件仅放行本 org。
    if (orgId) {
      events = events.filter((e) => e.orgId == null || e.orgId === orgId);
    }
    // Last-Event-ID 幂等过滤：丢弃 sequence <= lastEventId 的重复事件。
    if (lastEventId != null) {
      events = events.filter((e) => e.sequence > lastEventId);
    }

    this.lastSequence = Math.max(this.lastSequence, latest);
    return { events, resyncNeeded: false, gap: false, currentSequence: latest };
  }

  /**
   * 启动轮询：每 2s 拉取最新 outbox，按 sequence + eventId 去重后推送新事件。
   * Task 6：若注入了 notifyListener（SCHEDULER_STREAM_NOTIFY=1），
   * 同时订阅 outbox LISTEN/NOTIFY —— 收到通知立即触发一次 poll，把 SSE 延迟从 ~2s 降到近实时。
   * NOTIFY 只是 wake-up 优化：订阅失败仅告警，轮询兜底不变（不是唯一事实源）。
   */
  async start(): Promise<void> {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    if (this.notifyListener) {
      try {
        this.notifyUnsubscribe = this.notifyListener.subscribe(() => {
          void this.poll();
        });
        this.logger.log('scheduler stream notify listener subscribed');
      } catch (err) {
        // LISTEN 失败 → 降级纯轮询，不影响事件交付（durable outbox + sequence 语义不变）。
        this.logger.warn(
          'scheduler stream notify listener subscribe failed; falling back to polling only',
          err instanceof Error ? err.stack : String(err),
        );
        this.notifyUnsubscribe = null;
      }
    }
    this.logger.log('scheduler stream polling started');
  }

  /** 停止轮询并取消 notify 订阅（幂等；unsubscribe 抛错仅告警）。 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.notifyUnsubscribe) {
      try {
        this.notifyUnsubscribe();
      } catch (err) {
        this.logger.warn(
          'scheduler stream notify listener unsubscribe failed',
          err instanceof Error ? err.stack : String(err),
        );
      }
      this.notifyUnsubscribe = null;
    }
  }

  /** Nest 生命周期：应用关闭时清理定时器与 LISTEN 订阅。 */
  onModuleDestroy(): void {
    this.stop();
  }

  /** 返回可订阅的事件流。 */
  events(): Observable<SchedulingEvent> {
    return this.subject.asObservable();
  }

  private async poll(): Promise<void> {
    try {
      const events = await this.outboxService.listLatest(POLL_BATCH);
      // 倒序 → 升序，保证按 sequence 顺序推送。
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e.sequence > this.lastSequence && !this.seenEventIds.has(e.id)) {
          this.lastSequence = e.sequence;
          this.rememberEventId(e.id);
          this.subject.next(this.toEvent(e));
        }
      }
    } catch (err) {
      this.logger.error(
        'scheduler stream poll failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  private toEvent(e: OutboxEvent): SchedulingEvent {
    const payload = e.payload ?? {};
    return {
      eventId: e.id,
      eventType: e.eventType,
      entityId: e.entityId,
      version: 1,
      sequence: e.sequence,
      payload,
      entityType: e.entityType,
      entityVersion: e.entityVersion,
      // Phase 3 / P3-T2：envelope 增强（snapshotVersion/planId/occurredAt），从 outbox payload 透传。
      snapshotVersion:
        typeof payload.snapshotVersion === 'string' ? payload.snapshotVersion : null,
      planId: typeof payload.planId === 'string' ? payload.planId : null,
      occurredAt:
        typeof payload.occurredAt === 'string'
          ? payload.occurredAt
          : new Date().toISOString(),
      // P4-SSE：统一 envelope（orgId + correlationId；correlation 从 payload 或事件本身透传）。
      orgId: (e as { orgId?: string | null }).orgId ?? null,
      correlationId:
        typeof payload.correlationId === 'string'
          ? payload.correlationId
          : null,
      sourceTs: e.createdAt,
      serverTs: new Date().toISOString(),
    };
  }
}