import { Injectable, Inject, Logger, BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, eq } from 'drizzle-orm';
import { ewohMaintenanceCondition, ewohEvent } from '@server/database/schema';
import { deriveWorkOrderId } from '@server/common/workorder-ids';
import {
  isMaintenanceOverdue,
  maintenanceTransitionAllowed,
  validateMaintenanceCondition,
  type MaintenanceStatus,
} from '@shared/maintenance';
import { normalizeSeverity } from '@shared/risk';
import { buildEventEnvelope, envelopeForEvidence } from '@shared/event-envelope';
import { WorkOrderService } from '../workorder/workorder.service';

export interface CreateConditionInput {
  conditionId: string;
  subjectEntityId: string;
  conditionType: string;
  severity: string;
  dueAt?: string | null;
  evidenceId?: string | null;
}

export interface TransitionInput {
  to: string;
  workOrderRef?: string | null;
}

/**
 * Maintenance 服务（ADR-010 / NO-05b）：维护状态事实的注册与生命周期转移。
 *
 * - 契约校验 fail-closed（shared/maintenance.ts validateMaintenanceCondition，与边缘 Python 同向量）；
 * - severity 归一化为 Canonical Risk 阶梯（ADR-007）；
 * - 状态转移按契约（resolved 前必须 work_order_created；closed 终态）；
 * - 事件落库：创建 → MaintenanceConditionDetected；resolved → MaintenanceConditionResolved
 *   （信封遵循 ADR-009，eventType 对齐 contracts/events/event-catalog.yaml）；
 *   work_order_created（带引用）→ WorkOrderService 唯一权威写路径创建工单 +
 *   WorkOrderCreated（ADR-012 / NO-05e-b）；
 * - 租户边界 orgId + DB 层 RLS（standalone_034）双保险。
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly workOrderService: WorkOrderService,
  ) {}

  async createCondition(input: CreateConditionInput, orgId: string) {
    if (!orgId) throw new BadRequestException('orgId 缺失：维护状态注册必须带租户上下文');
    const errors = validateMaintenanceCondition({
      conditionId: input.conditionId,
      subjectEntityId: input.subjectEntityId,
      conditionType: input.conditionType,
      severity: input.severity,
      status: 'detected',
    });
    if (errors.length > 0) {
      throw new BadRequestException(`维护状态违反契约: ${errors.join(', ')}`);
    }
    // NEST-441：subjectKind 用 split 派生并校验（indexOf 无冒号返回 -1，
    // slice(0,-1) 会产出截断垃圾值）。
    const subjectParts = input.subjectEntityId.split(':');
    if (subjectParts.length < 2 || !subjectParts[0].trim() || !subjectParts[1].trim()) {
      throw new BadRequestException(
        `subjectEntityId 必须为 "<kind>:<id>" 形态（收到 ${input.subjectEntityId}）`,
      );
    }
    const kind = subjectParts[0];
    const row = {
      orgId,
      conditionId: input.conditionId,
      subjectEntityId: input.subjectEntityId,
      subjectKind: kind,
      conditionType: input.conditionType,
      severity: normalizeSeverity(input.severity),
      status: 'detected' as MaintenanceStatus,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      detectedAt: new Date(),
      resolvedAt: null,
      workOrderRef: null,
      evidenceId: input.evidenceId ?? null,
    };
    const inserted = await this.db.insert(ewohMaintenanceCondition).values(row).returning();
    await this.recordEvent(orgId, inserted[0], 'MaintenanceConditionDetected');
    return inserted[0];
  }

  async listConditions(orgId: string, filters?: { status?: string; overdue?: boolean }) {
    if (!orgId) throw new BadRequestException('orgId 缺失：维护状态查询必须带租户上下文');
    const conditions = [eq(ewohMaintenanceCondition.orgId, orgId)];
    if (filters?.status) conditions.push(eq(ewohMaintenanceCondition.status, filters.status));
    const rows = await this.db
      .select()
      .from(ewohMaintenanceCondition)
      .where(and(...conditions))
      .limit(500);
    const now = new Date().toISOString();
    const mapped = rows.map((r) => ({
      ...r,
      dueAt: r.dueAt ? r.dueAt.toISOString() : null,
      detectedAt: r.detectedAt.toISOString(),
      resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
      overdue: isMaintenanceOverdue(
        r.dueAt ? r.dueAt.toISOString() : null,
        r.status,
        now,
      ),
    }));
    if (filters?.overdue != null) {
      return mapped.filter((r) => r.overdue === filters.overdue);
    }
    return mapped;
  }

  async transitionCondition(conditionId: string, input: TransitionInput, orgId: string) {
    if (!orgId) throw new BadRequestException('orgId 缺失：维护状态转移必须带租户上下文');
    const rows = await this.db
      .select()
      .from(ewohMaintenanceCondition)
      .where(
        and(
          eq(ewohMaintenanceCondition.orgId, orgId),
          eq(ewohMaintenanceCondition.conditionId, conditionId),
        ),
      );
    if (rows.length === 0) throw new BadRequestException('维护状态不存在');
    const current = rows[0];
    if (!maintenanceTransitionAllowed(current.status, input.to)) {
      throw new BadRequestException(
        `非法状态转移 ${current.status} → ${input.to}（契约 lifecycle 顺序强制）`,
      );
    }
    const set: Record<string, unknown> = { status: input.to, updatedAt: new Date() };
    if (input.to === 'work_order_created' && input.workOrderRef) {
      set.workOrderRef = input.workOrderRef;
    }
    if (input.to === 'resolved') set.resolvedAt = new Date();
    // NEST-436：CAS（status 谓词）——并发转移命中 0 行时 409，杜绝
    // 双方都读到 detected 后重复建工单。
    const updatedRows = await this.db
      .update(ewohMaintenanceCondition)
      .set(set)
      .where(
        and(
          eq(ewohMaintenanceCondition.orgId, orgId),
          eq(ewohMaintenanceCondition.id, current.id),
          eq(ewohMaintenanceCondition.status, current.status),
        ),
      )
      .returning({ id: ewohMaintenanceCondition.id });
    if (updatedRows.length === 0) {
      throw new ConflictException('STATE_CONFLICT');
    }
    // NO-05e（ADR-012）：work_order_created 且带工单引用 → 经 WorkOrderService
    // （唯一权威写路径）创建真实工单行 + WorkOrderCreated 事件。内部 workOrderId
    // 由 EWOH 确定性推导；外部工单号仅作 externalRef alias（ADR-006）。
    if (input.to === 'work_order_created' && input.workOrderRef) {
      await this.workOrderService.createWorkOrder(
        {
          workOrderId: deriveWorkOrderId('maintenance', current.conditionId),
          workOrderType: 'maintenance',
          origin: { kind: 'maintenance_condition', id: current.conditionId },
          subjectEntityId: current.subjectEntityId,
          severity: current.severity,
          externalRef: input.workOrderRef,
        },
        orgId,
      );
    }
    if (input.to === 'resolved') {
      const updated = await this.db
        .select()
        .from(ewohMaintenanceCondition)
        .where(and(eq(ewohMaintenanceCondition.orgId, orgId), eq(ewohMaintenanceCondition.id, current.id)))
        .limit(1);
      await this.recordEvent(orgId, updated[0], 'MaintenanceConditionResolved');
    }
    return { conditionId, from: current.status, to: input.to };
  }

  private async recordEvent(
    orgId: string,
    row: typeof ewohMaintenanceCondition.$inferSelect,
    eventType: 'MaintenanceConditionDetected' | 'MaintenanceConditionResolved',
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
      source: 'cloud:maintenance',
      subject: row.subjectEntityId,
    });
    const envelopeRecord = envelopeForEvidence(envelope);
    await this.db.insert(ewohEvent).values({
      eventId,
      eventType,
      eventCode: eventType === 'MaintenanceConditionDetected' ? 'MC_DETECTED' : 'MC_RESOLVED',
      severity: row.severity,
      title: `${eventType}: ${row.conditionType} on ${row.subjectEntityId}`,
      status: 'open',
      sourceType: 'maintenance',
      orgId,
      createdAt: now,
      
      // ADR-009 / standalone_066: Event Envelope

      occurredAt: now,

      // ADR-009 / standalone_066: Event Envelope

      receivedAt: now,

      // ADR-009 / standalone_066: Event Envelope

      schemaVersion: '1.0.0',

      // ADR-009 / standalone_066: Event Envelope

      correlationId: null,

      // ADR-009 / standalone_066: Event Envelope

      causationId: null,

      // ADR-009 / standalone_066: Event Envelope

      confidence: null,
evidenceJson: {
        conditionId: row.conditionId,
        subjectEntityId: row.subjectEntityId,
        conditionType: row.conditionType,
        envelope: envelopeRecord.envelope,
        envelopeSemantics: envelopeRecord.envelopeSemantics,
      },
    });
  }
}
