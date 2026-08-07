import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { ewohOutbox } from '@server/database/schema';
import { asc, desc, eq, gt, max } from 'drizzle-orm';
import type { OutboxEvent } from '@shared/api.interface';

/** 入队可选的实体元数据（用于 SSE 缺口判定与影响分析的事件分类）。 */
export interface OutboxEnqueueOpts {
  entityType?: string;
  entityVersion?: number;
}

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
    opts?: OutboxEnqueueOpts,
  ): Promise<OutboxEvent> {
    const seq = sequence ?? (await this.nextSequence());
    const eventId = `EVT-${Date.now()}-${this.randomSuffix()}`;
    const [row] = await this.db
      .insert(ewohOutbox)
      .values({
        eventId,
        eventType,
        entityId,
        entityType: opts?.entityType ?? null,
        entityVersion: opts?.entityVersion ?? null,
        sequence: seq,
        status: 'pending',
        payloadJson: payload,
        orgId,
      })
      .returning();

    return this.toEvent(row);
  }

  /** 下一个 sequence（当前最大 sequence + 1）。 */
  async nextSequence(): Promise<number> {
    const [row] = await this.db
      .select({ m: max(ewohOutbox.sequence) })
      .from(ewohOutbox);
    return (row?.m ?? 0) + 1;
  }

  /** 当前最大 sequence（无事件时为 0）。 */
  async latestSequence(): Promise<number> {
    const [row] = await this.db
      .select({ m: max(ewohOutbox.sequence) })
      .from(ewohOutbox);
    return row?.m ?? 0;
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

  /** 按 sequence 升序返回 sequence > sinceSequence 的事件（SSE 重放/增量）。 */
  async listSince(sinceSequence: number, limit = 1000): Promise<OutboxEvent[]> {
    const rows = await this.db
      .select()
      .from(ewohOutbox)
      .where(gt(ewohOutbox.sequence, sinceSequence))
      .orderBy(asc(ewohOutbox.sequence))
      .limit(limit);
    return rows.map((r) => this.toEvent(r));
  }

  /** 按 sequence 倒序返回最近的事件。 */
  async listLatest(limit: number): Promise<OutboxEvent[]> {
    const rows = await this.db
      .select()
      .from(ewohOutbox)
      .orderBy(desc(ewohOutbox.sequence))
      .limit(limit);
    return rows.map((r) => this.toEvent(r));
  }

  private toEvent(row: typeof ewohOutbox.$inferSelect): OutboxEvent {
    return {
      id: row.eventId,
      eventType: row.eventType,
      entityId: row.entityId,
      payload: (row.payloadJson ?? {}) as Record<string, unknown>,
      status: row.status as OutboxEvent['status'],
      sequence: row.sequence,
      entityType: row.entityType ?? undefined,
      entityVersion: row.entityVersion ?? undefined,
      createdAt: row.createdAt
        ? row.createdAt.toISOString()
        : new Date().toISOString(),
    };
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