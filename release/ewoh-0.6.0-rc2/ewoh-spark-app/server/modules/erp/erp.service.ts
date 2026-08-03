import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  ewohEvent,
  ewohScheduleTask,
  ewohScheduleTaskStep,
} from '@server/database/schema';
import { AuditService } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';

const ERP_ORDER = 'ERP_ORDER';
const ERP_OUTBOUND = 'ERP_OUTBOUND';

@Injectable()
export class ErpService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
  ) {}

  async receiveOrder(
    body: {
      externalOrderId: string;
      productCode: string;
      quantity: number;
      dueDate?: string;
      bom?: Array<{ materialId: string; quantity: number }>;
    },
    actor?: OrgContext,
  ) {
    if (!body.externalOrderId?.trim() || !body.productCode?.trim()) {
      throw new BadRequestException(
        'externalOrderId and productCode are required',
      );
    }
    const quantity = Number(body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new BadRequestException('quantity must be a positive number');
    }
    const existing = await this.findByEvidence(
      ERP_ORDER,
      'externalOrderId',
      body.externalOrderId,
    );
    if (existing) {
      return { duplicate: true, order: existing };
    }

    const workOrderId = `WO-ERP-${randomUUID().slice(0, 8)}`;
    const now = new Date();
    await this.db.insert(ewohScheduleTask).values({
      scheduleTaskId: workOrderId,
      title: `ERP订单 ${body.externalOrderId}`,
      description: JSON.stringify({
        externalOrderId: body.externalOrderId,
        productCode: body.productCode,
        quantity,
        bom: body.bom ?? [],
        erp: true,
      }),
      status: 'draft',
      priority: 'high',
      source: 'erp',
      planEnd: body.dueDate ? new Date(body.dueDate) : null,
      isSimulation: false,
      progress: 0,
    });
    await this.db.insert(ewohScheduleTaskStep).values({
      stepId: `${workOrderId}-S1`,
      scheduleTaskId: workOrderId,
      stepNo: 1,
      name: 'ERP生产',
      status: 'pending',
      progress: 0,
    });

    const eventId = `ERP-O-${randomUUID().slice(0, 8)}`;
    const [order] = await this.db
      .insert(ewohEvent)
      .values({
        eventId,
        eventCode: ERP_ORDER,
        eventType: 'erp_order',
        severity: 'L2',
        title: `ERP订单 ${body.externalOrderId}`,
        status: 'received',
        createdAt: now,
        sourceType: 'real',
        evidenceJson: {
          externalOrderId: body.externalOrderId,
          productCode: body.productCode,
          quantity,
          dueDate: body.dueDate ?? null,
          bom: body.bom ?? [],
          workOrderId,
          receivedAt: now.toISOString(),
        },
      })
      .returning();
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'erp.order.receive',
      entityType: 'event',
      entityId: eventId,
      before: null,
      after: {
        externalOrderId: body.externalOrderId,
        workOrderId,
        quantity,
      },
    });
    return { duplicate: false, order, workOrderId };
  }

  async listOrders() {
    return this.db
      .select()
      .from(ewohEvent)
      .where(eq(ewohEvent.eventCode, ERP_ORDER))
      .orderBy(desc(ewohEvent.createdAt));
  }

  async receiveOutbound(
    body: {
      outboundId: string;
      type: 'production_report' | 'material_consumption' | 'inventory_receipt';
      externalOrderId: string;
      payload: Record<string, unknown>;
    },
    actor?: OrgContext,
  ) {
    if (!body.outboundId?.trim() || !body.externalOrderId?.trim()) {
      throw new BadRequestException(
        'outboundId and externalOrderId are required',
      );
    }
    const existing = await this.findByEvidence(
      ERP_OUTBOUND,
      'outboundId',
      body.outboundId,
    );
    if (existing) {
      return { duplicate: true, outbound: existing };
    }
    const eventId = `ERP-X-${randomUUID().slice(0, 8)}`;
    const [outbound] = await this.db
      .insert(ewohEvent)
      .values({
        eventId,
        eventCode: ERP_OUTBOUND,
        eventType: 'erp_outbound',
        severity: 'L1',
        title: `ERP出站 ${body.type}`,
        status: 'pending',
        createdAt: new Date(),
        sourceType: 'real',
        evidenceJson: {
          outboundId: body.outboundId,
          type: body.type,
          externalOrderId: body.externalOrderId,
          payload: body.payload,
          attempts: 0,
          createdAt: new Date().toISOString(),
        },
      })
      .returning();
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'erp.outbound.receive',
      entityType: 'event',
      entityId: eventId,
      before: null,
      after: {
        outboundId: body.outboundId,
        type: body.type,
        externalOrderId: body.externalOrderId,
      },
    });
    return { duplicate: false, outbound };
  }

  async listOutbound() {
    return this.db
      .select()
      .from(ewohEvent)
      .where(eq(ewohEvent.eventCode, ERP_OUTBOUND))
      .orderBy(desc(ewohEvent.createdAt));
  }

  async ackOutbound(
    eventId: string,
    body: { success: boolean; error?: string },
    actor?: OrgContext,
  ) {
    const [row] = await this.db
      .select()
      .from(ewohEvent)
      .where(
        and(
          eq(ewohEvent.eventId, eventId),
          eq(ewohEvent.eventCode, ERP_OUTBOUND),
        ),
      );
    if (!row) {
      throw new NotFoundException(`ERP outbound ${eventId} not found`);
    }
    const evidence = {
      ...((row.evidenceJson as Record<string, unknown> | null) ?? {}),
    };
    const attempts = Number(evidence.attempts ?? 0) + 1;
    evidence.attempts = attempts;
    evidence.ackAt = new Date().toISOString();
    if (body.success) {
      evidence.ackStatus = 'success';
    } else {
      evidence.ackStatus = 'failed';
      evidence.error = body.error ?? null;
    }
    const status = body.success ? 'sent' : 'failed';
    const [updated] = await this.db
      .update(ewohEvent)
      .set({ status, evidenceJson: evidence, handlerAction: status })
      .where(eq(ewohEvent.eventId, eventId))
      .returning();
    if (!updated) {
      throw new ConflictException('STATE_CONFLICT');
    }
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'erp.outbound.ack',
      entityType: 'event',
      entityId: eventId,
      before: { status: row.status, attempts: Number(evidence.attempts) - 1 },
      after: { status: updated.status, attempts },
    });
    return updated;
  }

  async reconcile() {
    const [orders, outbound] = await Promise.all([
      this.listOrders(),
      this.listOutbound(),
    ]);
    const completedWorkOrders = await this.db
      .select()
      .from(ewohScheduleTask)
      .where(
        and(
          eq(ewohScheduleTask.source, 'erp'),
          eq(ewohScheduleTask.status, 'completed'),
        ),
      );
    const countByStatus = (rows: Array<{ status: string | null }>) =>
      rows.reduce<Record<string, number>>((acc, row) => {
        const key = row.status ?? 'unknown';
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
    return {
      orders: {
        total: orders.length,
        byStatus: countByStatus(orders),
      },
      outbound: {
        total: outbound.length,
        byStatus: countByStatus(outbound),
      },
      completedErpWorkOrders: completedWorkOrders.length,
    };
  }

  private async findByEvidence(
    eventCode: string,
    key: string,
    value: string,
  ) {
    const rows = await this.db.execute(sql`
      select *
      from public.ewoh_event
      where event_code = ${eventCode}
        and evidence_json->>${key} = ${value}
      limit 1
    `);
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      ...row,
      eventId: row.event_id ?? row.eventId,
    };
  }
}
