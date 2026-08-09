import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { ewohOutbox } from '@server/database/schema';
import { and, asc, desc, eq, gt, gte, max } from 'drizzle-orm';
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

  /**
   * 节流入队（合并窗口，C4：resource.state_changed 等高频事件的事件风暴防护）。
   *
   * 语义：窗口 windowMs 内，同一 eventType + entityId 的 pending 事件只保留一条，
   * 后续变化仅覆盖 payload（最终态合并），不新增 outbox 行。
   *
   * 边界（务实裁定）：
   * - 合并时不更新 sequence → SSE 轮询只推送首条（提示变化），客户端最终态走 snapshot 重拉；
   *   避免 sequence 跳变触发 replaySince 缺口误判（gap=false 依赖 sequence 严格连续）。
   * - 窗口按首次落地 createdAt 计算，连续高频事件持续合并直到安静 windowMs 后落地下一条。
   * - 跨实体（不同 entityId / eventType）互不影响。
   */
  async enqueueThrottled(
    eventType: string,
    entityId: string,
    payload: Record<string, unknown>,
    orgId: string | null,
    windowMs = 5_000,
    opts?: OutboxEnqueueOpts,
  ): Promise<OutboxEvent> {
    const cutoff = new Date(Date.now() - windowMs);
    const [existing] = await this.db
      .select()
      .from(ewohOutbox)
      .where(
        and(
          eq(ewohOutbox.eventType, eventType),
          eq(ewohOutbox.entityId, entityId),
          eq(ewohOutbox.status, 'pending'),
          gte(ewohOutbox.createdAt, cutoff),
        ),
      )
      .limit(1);
    if (existing) {
      // 窗口命中：覆盖 payload 为最终态（保持 sequence 不变，无缺口副作用）
      const [updated] = await this.db
        .update(ewohOutbox)
        .set({ payloadJson: payload })
        .where(eq(ewohOutbox.id, existing.id))
        .returning();
      return this.toEvent(updated);
    }
    return this.enqueue(eventType, entityId, payload, orgId, undefined, opts);
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