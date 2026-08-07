import { Injectable, Logger } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import type { SchedulingEvent, OutboxEvent } from '@shared/api.interface';
import { OutboxService } from './outbox.service';

const POLL_INTERVAL_MS = 2_000;
const POLL_BATCH = 500;

/**
 * 调度实时事件流服务（SSE 基础）：轮询 outbox，将新事件推送到 Subject。
 * 不做完整 WebSocket，仅提供可订阅的 Observable 事件源。
 */
@Injectable()
export class SchedulerStreamService {
  private readonly logger = new Logger(SchedulerStreamService.name);
  private readonly subject = new Subject<SchedulingEvent>();
  private lastSequence = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly outboxService: OutboxService) {}

  /** 读取最近 limit 条事件并映射为 SchedulingEvent。 */
  async snapshot(limit: number): Promise<SchedulingEvent[]> {
    const events = await this.outboxService.listLatest(limit);
    return events.map((e) => this.toEvent(e));
  }

  /** 启动轮询：每 2s 拉取最新 outbox，按 sequence 去重后推送新事件。 */
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
      for (const e of events) {
        if (e.sequence > this.lastSequence) {
          this.lastSequence = e.sequence;
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
      sourceTs: e.createdAt,
      serverTs: new Date().toISOString(),
    };
  }
}