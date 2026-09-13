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
import { isBomBasis, parseMaterialMovement, type BomBasis } from '@shared/material-inventory';
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

  /**
   * 并发双提交去重的串行化原语：findByEvidence 是 check-then-act（evidence jsonb
   * 上没有唯一索引兜底），两个并发同单号请求会双双判"不存在"→ 双写 ERP_ORDER
   * （物料需求投影双计）/ ERP_OUTBOUND（库存投影双计，伪造库存事实）。
   * HTTP 请求整体运行在单事务里（OrgContextInterceptor），事务级 advisory lock
   * 持有到请求提交：后到者等前一个请求提交后才能进入查重，读到已提交行 →
   * 走 duplicate 返回。锁在任何读写之前获取、按 (org, 单号) 线性化，无死锁环。
   */
  private async lockInboundKey(orgId: string, externalKey: string): Promise<void> {
    // 与 resource-reservation 同纪律：仅"无 execute 能力的测试替身"跳过锁
    // （单进程测试无并发）；真实 PG 上锁失败必须向上抛（事务回滚，绝不静默放行）。
    if (typeof (this.db as { execute?: unknown }).execute !== 'function') {
      return;
    }
    await this.db.execute(
      sql`select pg_advisory_xact_lock(hashtext(${orgId}), hashtext(${externalKey}))`,
    );
  }

  async receiveOrder(
    body: {
      externalOrderId: string;
      productCode: string;
      quantity: number;
      dueDate?: string;
      bom?: Array<{ materialId: string; quantity: number; /** NO-29b：BOM 行单位（与库存单位对齐校验用）。 */ unit?: string }>;
      /** NO-28a：BOM 数量口径（缺省 per_unit；非法值 400）。 */
      bomBasis?: BomBasis;
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
    // NO-28a：BOM 口径必须显式声明（每件用量 / 整单用量）——两者相差一个订单数量，
    // 猜错就是几倍的物料缺口。缺省按 per_unit（最常见的 BOM 语义）并在事件里**写明**，
    // 使"这单需求怎么算的"永远可核对；显式传入非法值 → 400（不静默取默认）。
    const bomBasisRaw = (body as { bomBasis?: unknown }).bomBasis;
    if (bomBasisRaw !== undefined && bomBasisRaw !== null && String(bomBasisRaw).trim() !== '' && !isBomBasis(bomBasisRaw)) {
      throw new BadRequestException(
        `bomBasis 必须是 per_unit（每件用量）或 per_order（整单用量）；收到「${String(bomBasisRaw)}」`,
      );
    }
    const bomBasis: BomBasis = isBomBasis(bomBasisRaw) ? bomBasisRaw : 'per_unit';
    // NO-29b：BOM 行单位可选，但**给了就必须是合法非空字符串**——单位写错（如 'kg ' 之外
    // 的乱码）会让"库存 vs 需求"的比较失去意义，宁可在入口拒绝。
    for (const [index, line] of (body.bom ?? []).entries()) {
      if (line?.unit === undefined || line?.unit === null) continue;
      if (typeof line.unit !== 'string' || line.unit.trim() === '') {
        throw new BadRequestException(
          `bom[${index}].unit 必须是合法的非空字符串（收到 ${JSON.stringify(line.unit)}）`,
        );
      }
    }
    const orgId = this.requireOrgId(actor);
    await this.lockInboundKey(orgId, body.externalOrderId);
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
          bomBasis,
          erp: true,
        }),
        status: 'draft',
        priority: 'high',
        source: 'erp',
        // P1（2026-08-19 审计）：日期入参显式校验（原 Invalid Date → 稳定 500）。
        planEnd: parseDateInput(body.dueDate, 'dueDate'),
        isSimulation: false,
        progress: 0,
        // NEST-302：调度表写入显式携带 orgId——缺省时租户上下文被 RLS WITH CHECK
        // 拒写（ERP 接单 500），global_admin 则落 org_id=NULL 行（本租户此后
        // RLS/app 谓词双重不可见：订单"接收成功"但工单永远查不到）。
        orgId,
      },
      [
        {
          stepId: `${workOrderId}-S1`,
          scheduleTaskId: workOrderId,
          stepNo: 1,
          name: 'ERP生产',
          status: 'pending',
          progress: 0,
          orgId,
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
          bomBasis,
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
    // 与 receiveOrder 同口径：先按 (org, outboundId) 串行化，再查重（并发双提交
    // 会双写 ERP_OUTBOUND 事件 → 库存投影把同一笔物料流动计两次）。
    await this.lockInboundKey(orgId, body.outboundId);
    // NO-27a：物料流动载荷过契约（fail-closed）。
    //  - 合法 → 把**规范化后的**物料流动写进 evidence（库存投影只认这份带类型的字段）；
    //  - 历史自由格式（完全不含物料字段）→ 放行，但显式标注"不可解析"，绝不猜测；
    //  - 含物料字段却形状非法 → 400 逐条说明（宁可拒绝，也不写脏事实）。
    const movement = parseMaterialMovement(body.type, body.payload, { at: new Date().toISOString() });
    if (movement.status === 'invalid') {
      throw new BadRequestException(
        `物料流动载荷不符合契约（${body.type}）：${movement.errors.join('；')}`,
      );
    }
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
          // 规范化后的物料流动（NO-27a）；历史自由格式标 legacy 以便库存投影如实列出缺口
          materialMovement: movement.status === 'ok' ? movement.movement : null,
          materialMovementParse: movement.status,
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
