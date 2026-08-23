import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { sql, eq, and, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { parseDateInput } from '../shared/parse-date-input';
import {
  ewohEvent,
  ewohScheduleTask,
} from '@server/database/schema';
import { AuditService } from '../shared/audit.service';
import { MesService } from '../mes/mes.service';
import type { OrgContext } from '../shared/org-context.interceptor';

const ERP_ORDER = 'ERP_ORDER';
const ERP_OUTBOUND = 'ERP_OUTBOUND';

/**
 * NEST-445：findByEvidence 的 jsonb 键白名单（键名为 SQL 插值点，虽当前
 * 仅硬编码两值，仍显式收敛防未来把用户输入接进来）。
 */
const EVIDENCE_KEYS: ReadonlySet<string> = new Set(['externalOrderId', 'outboundId']);

@Injectable()
export class ErpService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
    private readonly mesService: MesService,
  ) {}

  /** NEST-406/407/408：org 上下文强制（缺失 401，绝不静默写全局/全量读）。 */
  private requireOrgId(actor?: OrgContext): string {
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new UnauthorizedException(
        'org 上下文缺失：ERP 读写必须带租户上下文',
      );
    }
    return orgId;
  }

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
    const orgId = this.requireOrgId(actor);
    const existing = await this.findByEvidence(
      ERP_ORDER,
      'externalOrderId',
      body.externalOrderId,
      orgId,
    );
    if (existing) {
      return { duplicate: true, order: existing };
    }

    const workOrderId = `WO-ERP-${randomUUID().slice(0, 8)}`;
    const now = new Date();
    await this.mesService.writeScheduleOrder(
      {
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
        // P1（2026-08-19 审计）：日期入参显式校验（原 Invalid Date → 稳定 500）。
        planEnd: parseDateInput(body.dueDate, 'dueDate'),
        isSimulation: false,
        progress: 0,
      },
      [
        {
          stepId: `${workOrderId}-S1`,
          scheduleTaskId: workOrderId,
          stepNo: 1,
          name: 'ERP生产',
          status: 'pending',
          progress: 0,
        },
      ],
    );

    const eventId = `ERP-O-${randomUUID().slice(0, 8)}`;
    const [order] = await this.db
      .insert(ewohEvent)
      .values({
        eventId,
        eventCode: ERP_ORDER,
        eventType: 'erp_order',
        severity: 'high',
        title: `ERP订单 ${body.externalOrderId}`,
        status: 'received',
        createdAt: now,
        // ADR-009 / standalone_066: Event Envelope fields.
        occurredAt: now,
        receivedAt: now,
        schemaVersion: '1.0.0',
        correlationId: null,
        causationId: null,
        confidence: null,
        sourceType: 'real',
        // NEST-406：写入显式携带 orgId。
        orgId,
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

  /** NEST-407：列表 org 过滤（global_admin 放行）。 */
  async listOrders(actor?: OrgContext) {
    if (actor?.isGlobalAdmin) {
      return this.db
        .select()
        .from(ewohEvent)
        .where(eq(ewohEvent.eventCode, ERP_ORDER))
        .orderBy(desc(ewohEvent.createdAt));
    }
    return this.db
      .select()
      .from(ewohEvent)
      .where(
        and(
          eq(ewohEvent.eventCode, ERP_ORDER),
          eq(ewohEvent.orgId, this.requireOrgId(actor)),
        ),
      )
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
    const orgId = this.requireOrgId(actor);
    const existing = await this.findByEvidence(
      ERP_OUTBOUND,
      'outboundId',
      body.outboundId,
      orgId,
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
        severity: 'critical',
        title: `ERP出站 ${body.type}`,
        status: 'pending',
        createdAt: new Date(),
        sourceType: 'real',
        // NEST-408：写入显式携带 orgId。
        orgId,
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

  /** NEST-407：列表 org 过滤（global_admin 放行）。 */
  async listOutbound(actor?: OrgContext) {
    if (actor?.isGlobalAdmin) {
      return this.db
        .select()
        .from(ewohEvent)
        .where(eq(ewohEvent.eventCode, ERP_OUTBOUND))
        .orderBy(desc(ewohEvent.createdAt));
    }
    return this.db
      .select()
      .from(ewohEvent)
      .where(
        and(
          eq(ewohEvent.eventCode, ERP_OUTBOUND),
          eq(ewohEvent.orgId, this.requireOrgId(actor)),
        ),
      )
      .orderBy(desc(ewohEvent.createdAt));
  }

  async ackOutbound(
    eventId: string,
    body: { success: boolean; error?: string },
    actor?: OrgContext,
  ) {
    // R2-SAM-001：写转移面与 list 面对称——org 谓词 + 归属校验
    //（global_admin 放行；非 global_admin 必须 org 上下文齐全且只碰本 org 行）。
    const ackOrgCondition =
      actor?.isGlobalAdmin
        ? undefined
        : eq(ewohEvent.orgId, this.requireOrgId(actor));
    const [row] = await this.db
      .select()
      .from(ewohEvent)
      .where(
        and(
          eq(ewohEvent.eventId, eventId),
          eq(ewohEvent.eventCode, ERP_OUTBOUND),
          ...(ackOrgCondition ? [ackOrgCondition] : []),
        ),
      );
    if (!row) {
      throw new NotFoundException(`ERP outbound ${eventId} not found`);
    }
    // NEST-426：读-改-写 evidenceJson 加 status CAS（并发 ack 丢更新收敛为 409）。
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
      .where(
        and(
          eq(ewohEvent.eventId, eventId),
          eq(ewohEvent.status, row.status ?? 'pending'),
          ...(ackOrgCondition ? [ackOrgCondition] : []),
        ),
      )
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

  async reconcile(actor?: OrgContext) {
    const [orders, outbound] = await Promise.all([
      this.listOrders(actor),
      this.listOutbound(actor),
    ]);
    const completedWorkOrders = await this.db
      .select()
      .from(ewohScheduleTask)
      .where(
        and(
          eq(ewohScheduleTask.source, 'erp'),
          eq(ewohScheduleTask.status, 'completed'),
          // NEST-407：工单核对同 org 作用域（global_admin 放行）。
          ...(actor?.isGlobalAdmin
            ? []
            : [eq(ewohScheduleTask.orgId, this.requireOrgId(actor))]),
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
    orgId: string,
  ) {
    // NEST-445：jsonb 键名白名单（插值点显式收敛）。
    if (!EVIDENCE_KEYS.has(key)) {
      throw new BadRequestException(`unsupported evidence key: ${key}`);
    }
    // ADR-079：drizzle 类型安全（raw SQL 完整清零）；
    // NEST-406/408：幂等查询加 org 维度（跨租户同单号互不干扰）。
    const rows = await this.db
      .select()
      .from(ewohEvent)
      .where(
        and(
          eq(ewohEvent.eventCode, eventCode),
          eq(ewohEvent.orgId, orgId),
          sql`evidence_json->>${key} = ${value}`,
        ),
      )
      .limit(1);
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
