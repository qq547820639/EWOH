import { Injectable, Logger } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import type { SchedulingEvent, OutboxEvent } from '@shared/api.interface';
import { OutboxService } from './outbox.service';

const POLL_INTERVAL_MS = 2_000;
const POLL_BATCH = 500;

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
export class SchedulerStreamService {
  private readonly logger = new Logger(SchedulerStreamService.name);
  private readonly subject = new Subject<SchedulingEvent>();
  private lastSequence = 0;
  private readonly seenEventIds = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly outboxService: OutboxService) {}

  /** 读取最近 limit 条事件并映射为 SchedulingEvent。 */
  async snapshot(limit: number): Promise<SchedulingEvent[]> {
    const events = await this.outboxService.listLatest(limit);
    return events.map((e) => this.toEvent(e));
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
    // Last-Event-ID 幂等过滤：丢弃 sequence <= lastEventId 的重复事件。
    if (lastEventId != null) {
      events = events.filter((e) => e.sequence > lastEventId);
    }

    this.lastSequence = Math.max(this.lastSequence, latest);
    return { events, resyncNeeded: false, gap: false, currentSequence: latest };
  }

  /** 启动轮询：每 2s 拉取最新 outbox，按 sequence + eventId 去重后推送新事件。 */
  async start(): Promise<void> {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.logger.log('scheduler stream polling started');
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
          this.seenEventIds.add(e.id);
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
    return {
      eventId: e.id,
      eventType: e.eventType,
      entityId: e.entityId,
      version: 1,
      sequence: e.sequence,
      payload: e.payload,
      entityType: e.entityType,
      entityVersion: e.entityVersion,
      sourceTs: e.createdAt,
      serverTs: new Date().toISOString(),
    };
  }
}