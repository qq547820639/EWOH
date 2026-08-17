import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, eq } from 'drizzle-orm';
import { ewohWorkOrder, ewohEvent } from '@server/database/schema';
import {
  validateWorkOrder,
  workOrderTransitionAllowed,
  type WorkOrderStatus,
} from '@shared/workorder';
import { normalizeSeverity } from '@shared/risk';
import { buildEventEnvelope, envelopeForEvidence } from '@shared/event-envelope';
import { deriveWorkOrderId } from '@server/common/workorder-ids';
import { currentTraceId } from '@server/common/request-context';

export interface CreateWorkOrderInput {
  workOrderId?: string | null;
  workOrderType: string;
  origin: { kind: string; id: string };
  subjectEntityId: string;
  severity: string;
  scheduledFor?: string | null;
  externalRef?: string | null;
  evidenceId?: string | null;
}

export interface TransitionWorkOrderInput {
  to: string;
  completedAt?: string | null;
  cancelledReason?: string | null;
}

/**
 * WorkOrder 服务（ADR-012 / NO-05e-b）：工单 Execution 事实的唯一权威写路径。
 *
 * - 契约校验 fail-closed（shared/workorder.ts validateWorkOrder，与边缘 Python
 *   同向量）；severity 归一化 Canonical Risk 阶梯；
 * - workOrderId 缺省由 origin 确定性推导（wo:sha256(originKind:originId)[:12]）；
 *   第三方工单号仅 externalRef alias（ADR-006，绝不当内部 ID）；
 * - 创建幂等：唯一 (org_id, work_order_id) 冲突 → 返回既有行，不重复发事件；
 * - 生命周期顺序强制（in_progress 起不可取消）；completed/closed 落 completedAt、
 *   cancelled 必带 reason（契约 + DB CHECK 双强制）；
 * - 事件：创建 → WorkOrderCreated；completed/closed → WorkOrderCompleted
 *   （信封 ADR-009，目录 contracts/events/event-catalog.yaml）；
 * - 租户边界 orgId + DB 层 RLS（standalone_035）双保险。
 */
@Injectable()
export class WorkOrderService {
  private readonly logger = new Logger(WorkOrderService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async createWorkOrder(input: CreateWorkOrderInput, orgId: string) {
    if (!orgId) throw new BadRequestException('orgId 缺失：工单创建必须带租户上下文');
    const workOrderId =
      input.workOrderId && input.workOrderId !== ''
        ? input.workOrderId
        : deriveWorkOrderId(input.origin.kind, input.origin.id);
    const errors = validateWorkOrder({
      workOrderId,
      workOrderType: input.workOrderType,
      origin: input.origin,
      subjectEntityId: input.subjectEntityId,
      severity: input.severity,
      status: 'created',
      ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
    });
    if (errors.length > 0) {
      throw new BadRequestException(`工单违反契约: ${errors.join(', ')}`);
    }
    const row = {
      orgId,
      workOrderId,
      workOrderType: input.workOrderType,
      originKind: input.origin.kind,
      originId: input.origin.id,
      subjectEntityId: input.subjectEntityId,
      // NEST-647：indexOf(':') 为 -1 时 slice(0,-1) 会截掉末字符——规范身份
      // 必为 'kind:id'（isCanonicalIdentity 校验），无冒号时诚实保留全串。
      subjectKind: (() => {
        const colonAt = input.subjectEntityId.indexOf(':');
        return colonAt > 0
          ? input.subjectEntityId.slice(0, colonAt)
          : input.subjectEntityId;
      })(),
      severity: normalizeSeverity(input.severity),
      status: 'created' as WorkOrderStatus,
      scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
      completedAt: null,
      cancelledReason: null,
      externalRef: input.externalRef ?? null,
      evidenceId: input.evidenceId ?? null,
    };
    let inserted;
    try {
      const result = await this.db.insert(ewohWorkOrder).values(row).returning();
      inserted = result[0];
      await this.recordEvent(orgId, inserted, 'WorkOrderCreated');
    } catch (err) {
      // 幂等重放：唯一 (org_id, work_order_id) 冲突 → 返回既有行，不重复发事件
      // （绝不静默吞其他异常——非 23505 一律重抛）。
      const code = (err as { code?: string }).code;
      if (code !== '23505') throw err;
      const existing = await this.db
        .select()
        .from(ewohWorkOrder)
        .where(
          and(eq(ewohWorkOrder.orgId, orgId), eq(ewohWorkOrder.workOrderId, workOrderId)),
        )
        .limit(1);
      if (existing.length === 0) throw err;
      this.logger.debug(`工单幂等重放命中: ${workOrderId}`);
      return { record: existing[0], created: false };
    }
    return { record: inserted, created: true };
  }

  async listWorkOrders(
    orgId: string,
    filters?: { status?: string; originKind?: string },
  ) {
    if (!orgId) throw new BadRequestException('orgId 缺失：工单查询必须带租户上下文');
    const conditions = [eq(ewohWorkOrder.orgId, orgId)];
    if (filters?.status) conditions.push(eq(ewohWorkOrder.status, filters.status));
    if (filters?.originKind) conditions.push(eq(ewohWorkOrder.originKind, filters.originKind));
    const rows = await this.db
      .select()
      .from(ewohWorkOrder)
      .where(and(...conditions))
      .limit(500);
    return rows.map((r) => ({
      ...r,
      scheduledFor: r.scheduledFor ? r.scheduledFor.toISOString() : null,
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    }));
  }

  async transitionWorkOrder(
    workOrderId: string,
    input: TransitionWorkOrderInput,
    orgId: string,
  ) {
    if (!orgId) throw new BadRequestException('orgId 缺失：工单转移必须带租户上下文');
    const rows = await this.db
      .select()
      .from(ewohWorkOrder)
      .where(and(eq(ewohWorkOrder.orgId, orgId), eq(ewohWorkOrder.workOrderId, workOrderId)));
    if (rows.length === 0) throw new BadRequestException('工单不存在');
    const current = rows[0];
    if (!workOrderTransitionAllowed(current.status, input.to)) {
      throw new BadRequestException(
        `非法状态转移 ${current.status} → ${input.to}（契约 lifecycle 顺序强制）`,
      );
    }
    const nextCompletedAt =
      input.to === 'completed' || input.to === 'closed'
        ? (input.completedAt ?? new Date().toISOString())
        : null;
    const errors = validateWorkOrder({
      workOrderId: current.workOrderId,
      workOrderType: current.workOrderType,
      origin: { kind: current.originKind, id: current.originId },
      subjectEntityId: current.subjectEntityId,
      severity: current.severity,
      status: input.to,
      ...(nextCompletedAt ? { completedAt: nextCompletedAt } : {}),
      ...(input.to === 'cancelled' && input.cancelledReason
        ? { cancelledReason: input.cancelledReason }
        : {}),
    });
    if (errors.length > 0) {
      throw new BadRequestException(`工单转移违反契约: ${errors.join(', ')}`);
    }
    const set: Record<string, unknown> = { status: input.to, updatedAt: new Date() };
    if (nextCompletedAt) set.completedAt = new Date(nextCompletedAt);
    if (input.to === 'cancelled') set.cancelledReason = input.cancelledReason;
    // NEST-628：更新加 eq(status=current.status) CAS + returning——并发双
    // 转移只有一个成功（原先 WHERE 仅 org+id，后写者覆盖先写者）。
    const updatedRows = await this.db
      .update(ewohWorkOrder)
      .set(set)
      .where(
        and(
          eq(ewohWorkOrder.orgId, orgId),
          eq(ewohWorkOrder.id, current.id),
          eq(ewohWorkOrder.status, current.status),
        ),
      )
      .returning();
    if (updatedRows.length === 0) {
      throw new BadRequestException(
        `工单状态已被并发修改（${current.status} → ${input.to} CAS 未命中）`,
      );
    }
    if (input.to === 'completed' || input.to === 'closed') {
      await this.recordEvent(orgId, updatedRows[0], 'WorkOrderCompleted');
    }
    return { workOrderId, from: current.status, to: input.to };
  }

  private async recordEvent(
    orgId: string,
    row: typeof ewohWorkOrder.$inferSelect,
    eventType: 'WorkOrderCreated' | 'WorkOrderCompleted',
  ) {
    const eventId = `EVT-${Math.floor(Date.now() / 1000)}-${randomUUID().slice(0, 8)}`;
    const now = new Date();
    const nowIso = now.toISOString();
    const envelope = buildEventEnvelope({
      eventId,
      eventType,
      occurredAt: nowIso,
      observedAt: nowIso,
      receivedAt: nowIso,
      source: 'cloud:workorder',
      subject: row.subjectEntityId,
      correlationId: currentTraceId() ?? null,
    });
    const envelopeRecord = envelopeForEvidence(envelope);
    await this.db.insert(ewohEvent).values({
      eventId,
      eventType,
      eventCode: eventType === 'WorkOrderCreated' ? 'WO_CREATED' : 'WO_COMPLETED',
      severity: row.severity,
      title: `${eventType}: ${row.workOrderType} ${row.workOrderId}`,
      status: 'open',
      sourceType: 'workorder',
      orgId,
      createdAt: now,
      evidenceJson: {
        workOrderId: row.workOrderId,
        workOrderType: row.workOrderType,
        origin: { kind: row.originKind, id: row.originId },
        subjectEntityId: row.subjectEntityId,
        ...(row.externalRef ? { externalWorkOrderRef: row.externalRef } : {}),
        envelope: envelopeRecord.envelope,
        envelopeSemantics: envelopeRecord.envelopeSemantics,
      },
    });
  }
}
