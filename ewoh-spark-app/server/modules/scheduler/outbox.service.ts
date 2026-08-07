import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { ewohOutbox } from '@server/database/schema';
import { desc, eq, max } from 'drizzle-orm';
import type { OutboxEvent } from '@shared/api.interface';

/** Outbox：可靠领域事件，先写 outbox 再发布，保证 dispatch 与事件一致。 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  /** 入队一个待发布事件，返回 OutboxEvent 形状。 */
  async enqueue(
    eventType: string,
    entityId: string,
    payload: Record<string, unknown>,
    orgId: string | null,
    sequence?: number,
  ): Promise<OutboxEvent> {
    const seq = sequence ?? (await this.nextSequence());
    const eventId = `EVT-${Date.now()}-${this.randomSuffix()}`;
    const [row] = await this.db
      .insert(ewohOutbox)
      .values({
        eventId,
        eventType,
        entityId,
        sequence: seq,
        status: 'pending',
        payloadJson: payload,
        orgId,
      })
      .returning();

    return {
      id: row.eventId,
      eventType: row.eventType,
      entityId: row.entityId,
      payload: (row.payloadJson ?? {}) as Record<string, unknown>,
      status: row.status as OutboxEvent['status'],
      sequence: row.sequence,
      createdAt: row.createdAt
        ? row.createdAt.toISOString()
        : new Date().toISOString(),
    };
  }

  /** 下一个 sequence（当前最大 sequence + 1）。 */
  async nextSequence(): Promise<number> {
    const [row] = await this.db
      .select({ m: max(ewohOutbox.sequence) })
      .from(ewohOutbox);
    return (row?.m ?? 0) + 1;
  }

  /** 将所有 pending 事件标记为 published，返回受影响行数。 */
  async publishPending(): Promise<number> {
    const now = new Date();
    const rows = await this.db
      .update(ewohOutbox)
      .set({ status: 'published', publishedAt: now })
      .where(eq(ewohOutbox.status, 'pending'))
      .returning();
    return rows.length;
  }

  /** 按 sequence 倒序返回最近的事件。 */
  async listLatest(limit: number): Promise<OutboxEvent[]> {
    const rows = await this.db
      .select()
      .from(ewohOutbox)
      .orderBy(desc(ewohOutbox.sequence))
      .limit(limit);
    return rows.map((r) => ({
      id: r.eventId,
      eventType: r.eventType,
      entityId: r.entityId,
      payload: (r.payloadJson ?? {}) as Record<string, unknown>,
      status: r.status as OutboxEvent['status'],
      sequence: r.sequence,
      createdAt: r.createdAt
        ? r.createdAt.toISOString()
        : new Date().toISOString(),
    }));
  }

  private randomSuffix(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 4; i++) {
      s += chars[Math.floor(Math.random() * chars.length)];
    }
    return s;
  }
}