import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { ewohOutbox } from '@server/database/schema';
import { and, asc, desc, eq, gt, gte, isNull, max, or, type SQL } from 'drizzle-orm';
import type { OutboxEvent } from '@shared/api.interface';

/** 入队可选的实体元数据（用于 SSE 缺口判定与影响分析的事件分类）。 */
export interface OutboxEnqueueOpts {
  entityType?: string;
  entityVersion?: number;
  // Phase 3 / P3-T2：SSE envelope 透传字段（snapshotVersion/planId/occurredAt）。
  snapshotVersion?: string | null;
  planId?: string | null;
  occurredAt?: string | null;
  // Phase 4 / P4-SSE：统一 Envelope 关联 ID（run/plan/execution/policy 全链路）。
  correlationId?: string | null;
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
    // B1 修复：sequence 未显式传入时不再用 SELECT MAX+1 计算（非原子），
    // 省略该字段由 DB DEFAULT（ewoh_outbox_sequence_seq）原子生成，RETURNING 取回真实值。
    // 显式传 sequence 的兼容路径保留（调用方仍可覆盖）。
    // NEST-047（2026-08-17）：Date.now()+短随机后缀 → randomUUID（密码学随机，
    // 消除高并发碰撞与可预测性）。
    const eventId = `EVT-${randomUUID()}`;
    // Phase 3 / P3-T2：envelope 透传字段写入 payload（SSE 端从 payload 读取）。
    const envelopePayload: Record<string, unknown> = { ...payload };
    if (opts?.snapshotVersion != null) envelopePayload.snapshotVersion = opts.snapshotVersion;
    if (opts?.planId != null) envelopePayload.planId = opts.planId;
    if (opts?.occurredAt != null) envelopePayload.occurredAt = opts.occurredAt;
    if (opts?.correlationId != null) envelopePayload.correlationId = opts.correlationId;
    const insertValues: typeof ewohOutbox.$inferInsert = {
      eventId,
      eventType,
      entityId,
      entityType: opts?.entityType ?? null,
      entityVersion: opts?.entityVersion ?? null,
      status: 'pending',
      payloadJson: envelopePayload,
      orgId,
      correlationId: opts?.correlationId ?? null,
    };
    if (sequence !== undefined) {
      insertValues.sequence = sequence;
    }
    const [row] = await this.db
      .insert(ewohOutbox)
      .values(insertValues)
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
    // NEST-013 修复（2026-08-17）：SELECT-then-UPDATE/INSERT 竞态改为
    // 原子 UPDATE ... RETURNING 先行——窗口内已有 pending 行时并发调用都在
    // 同一行上合并（DB 行锁串行化），不再出现「先查无、双双 INSERT」对既有
    // pending 行的重复插入。仅在窗口确无命中时才 INSERT（残余竞态最多产生
    // 两条 pending 行，后续窗口继续合并，无正确性破坏）。
    // NEST-017 修复：合并路径同步合并 opts 的 envelope 字段（此前更新只写
    // payload，entityType/correlationId 等元数据丢失）。
    const cutoff = new Date(Date.now() - windowMs);
    const mergedPayload: Record<string, unknown> = { ...payload };
    if (opts?.snapshotVersion != null) mergedPayload.snapshotVersion = opts.snapshotVersion;
    if (opts?.planId != null) mergedPayload.planId = opts.planId;
    if (opts?.occurredAt != null) mergedPayload.occurredAt = opts.occurredAt;
    if (opts?.correlationId != null) mergedPayload.correlationId = opts.correlationId;
    const [updated] = await this.db
      .update(ewohOutbox)
      .set({
        payloadJson: mergedPayload,
        // NEST-017：opts 提供时更新元数据；缺省保留原值（不回退抹掉）。
        ...(opts?.entityType != null ? { entityType: opts.entityType } : {}),
        ...(opts?.correlationId != null ? { correlationId: opts.correlationId } : {}),
      })
      .where(
        and(
          eq(ewohOutbox.eventType, eventType),
          eq(ewohOutbox.entityId, entityId),
          eq(ewohOutbox.status, 'pending'),
          gte(ewohOutbox.createdAt, cutoff),
        ),
      )
      .returning();
    if (updated) {
      // 窗口命中：payload 已覆盖为最终态（sequence 不变，无缺口副作用）。
      return this.toEvent(updated);
    }
    return this.enqueue(eventType, entityId, payload, orgId, undefined, opts);
  }

  /** 当前最大 sequence（无事件时为 0）。 */
  async latestSequence(): Promise<number> {
    const [row] = await this.db
      .select({ m: max(ewohOutbox.sequence) })
      .from(ewohOutbox);
    return row?.m ?? 0;
  }

  /**
   * 将 pending 事件标记为 published，返回受影响行数。
   *
   * NEST-016（2026-08-17）：可选 orgId 作用域。缺省（undefined/null）= 系统级
   * 全量发布——ewoh_outbox 为 GLOBAL_SHARED 表（standalone_057 裁决：eventId
   * 全局唯一、RLS 关闭），后台发布器跨 org 推送是显式系统语义；租户路径必须
   * 传 orgId 限定作用域。
   */
  async publishPending(orgId?: string | null): Promise<number> {
    const now = new Date();
    const rows = await this.db
      .update(ewohOutbox)
      .set({ status: 'published', publishedAt: now })
      .where(
        orgId
          ? and(eq(ewohOutbox.status, 'pending'), eq(ewohOutbox.orgId, orgId))
          : eq(ewohOutbox.status, 'pending'),
      )
      .returning();
    return rows.length;
  }

  /**
   * 按 sequence 升序返回 sequence > sinceSequence 的事件（SSE 重放/增量）。
   *
   * NEST-014（2026-08-17）：viewerOrgId 提供时仅返回该 org 事件 + 全局事件
   * （orgId IS NULL），杜绝跨租户重放泄露；缺省为系统级（GLOBAL_SHARED 表
   * 的后台运维路径，需显式系统语义）。
   */
  async listSince(
    sinceSequence: number,
    limit = 1000,
    viewerOrgId?: string | null,
  ): Promise<OutboxEvent[]> {
    const rows = await this.db
      .select()
      .from(ewohOutbox)
      .where(
        and(
          gt(ewohOutbox.sequence, sinceSequence),
          viewerOrgId ? this.orgVisibilityCondition(viewerOrgId) : undefined,
        ),
      )
      .orderBy(asc(ewohOutbox.sequence))
      .limit(limit);
    return rows.map((r) => this.toEvent(r));
  }

  /**
   * 按 sequence 倒序返回最近的事件。
   *
   * NEST-015（2026-08-17）：同 listSince——viewerOrgId 提供时按 org 过滤
   * （本 org + 全局事件），缺省为系统级。
   */
  async listLatest(
    limit: number,
    viewerOrgId?: string | null,
  ): Promise<OutboxEvent[]> {
    const rows = await this.db
      .select()
      .from(ewohOutbox)
      .where(viewerOrgId ? this.orgVisibilityCondition(viewerOrgId) : undefined)
      .orderBy(desc(ewohOutbox.sequence))
      .limit(limit);
    return rows.map((r) => this.toEvent(r));
  }

  /** SSE 可见性条件：本 org 事件 + 全局事件（orgId IS NULL，ADR-004 全局流语义）。 */
  private orgVisibilityCondition(viewerOrgId: string): SQL {
    return or(isNull(ewohOutbox.orgId), eq(ewohOutbox.orgId, viewerOrgId)) as SQL;
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
      // NEST-113/114（2026-08-17）：outbox 行 org_id 直读透传——SSE 订阅者
      // 按 org 过滤依赖该字段（此前缺失导致所有事件被当作全局事件放行）。
      orgId: row.orgId ?? null,
      createdAt: row.createdAt
        ? row.createdAt.toISOString()
        : new Date().toISOString(),
    };
  }
}