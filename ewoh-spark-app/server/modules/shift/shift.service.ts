import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ewohShift, ewohShiftHandover, ewohEvent } from '@server/database/schema';
import { DeviceResponsibilityService } from '../responsibility/device-responsibility.service';
import type { OrgContext } from '../shared/org-context.interceptor';
import {
  resolveShiftAt,
  type ShiftDefinition,
  type ShiftHandover,
  type ShiftHandoverOpenItem,
} from '@shared/shift';
import { buildEventEnvelope, envelopeForEvidence } from '@shared/event-envelope';
import { currentTraceId } from '@server/common/request-context';

export interface CreateShiftInput {
  shiftId?: string;
  name: string;
  code?: string | null;
  startTime: string;
  endTime: string;
  crossesMidnight?: boolean;
  leadUserId?: string | null;
  description?: string | null;
}

export interface CreateHandoverInput {
  handoverId?: string;
  shiftId: string;
  shiftDate?: string;
  fromUserId?: string | null;
  toUserId: string;
  openItems?: ShiftHandoverOpenItem[];
  notes?: string | null;
}

/**
 * 班次服务（standalone_074，DR-2 班次工作台）。
 *
 * - 班次定义 CRUD（active 窗口 + 跨零点语义），当前班次判定用共享纯函数
 *   resolveShiftAt（前后端同构，杜绝两侧口径漂移）；无匹配班次显式返回
 *   null，不猜测默认班（原则 7）；
 * - 交接班：结构化遗留事项 + 交接事实留痕 + ShiftHandoverRecorded 目录事件；
 * - 幂等：同 (org, shiftId/handoverId) 冲突返回既有行（created=false）；
 * - 租户：org_id NOT NULL + RLS（standalone_074）双保险。
 */
@Injectable()
export class ShiftService {
  private readonly logger = new Logger(ShiftService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    /**
     * NO-52a：交接班时核对"接班班次的责任人"。**可选注入**——责任域是新增能力，
     * 缺失时交接本身照常（快照为 null 并如实说明），不让一个辅助能力拖垮交接主流程。
     */
    @Optional() private readonly responsibilities?: DeviceResponsibilityService,
  ) {}

  private requireOrgId(actor?: OrgContext): string {
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org 上下文缺失：班次查询必须带租户上下文');
    }
    return orgId;
  }

  async listShifts(actor?: OrgContext, opts?: { activeOnly?: boolean }): Promise<ShiftDefinition[]> {
    const orgId = this.requireOrgId(actor);
    const conditions = [eq(ewohShift.orgId, orgId)];
    if (opts?.activeOnly) conditions.push(eq(ewohShift.active, true));
    const rows = await this.db
      .select()
      .from(ewohShift)
      .where(and(...conditions))
      .orderBy(ewohShift.startTime);
    return rows.map((r) => this.toShift(r));
  }

  /** 当前班次 + 下一班（共享纯函数判定；不在任何班次内 → current=null 显式未知）。 */
  async resolveCurrentShift(actor?: OrgContext, at: Date = new Date()) {
    const shifts = await this.listShifts(actor, { activeOnly: true });
    return resolveShiftAt(shifts, at);
  }

  async upsertShift(input: CreateShiftInput, actor?: OrgContext) {
    const orgId = this.requireOrgId(actor);
    const timeRe = /^\d{2}:\d{2}$/;
    if (!timeRe.test(input.startTime) || !timeRe.test(input.endTime)) {
      throw new BadRequestException('startTime/endTime 必须为 HH:mm');
    }
    if (input.startTime === input.endTime) {
      throw new BadRequestException('零长度班次窗口（startTime === endTime）被拒绝');
    }
    const crossesMidnight = input.crossesMidnight ?? input.startTime > input.endTime;
    const shiftId = input.shiftId?.trim() || `SHIFT-${randomUUID().slice(0, 8).toUpperCase()}`;
    const row = {
      orgId,
      shiftId,
      name: input.name,
      code: input.code ?? null,
      startTime: input.startTime,
      endTime: input.endTime,
      crossesMidnight,
      active: true,
      leadUserId: input.leadUserId ?? null,
      description: input.description ?? null,
    };
    const inserted = await this.db.insert(ewohShift).values(row).returning();
    return { record: this.toShift(inserted[0]), created: true };
  }

  async createHandover(input: CreateHandoverInput, actor?: OrgContext) {
    const orgId = this.requireOrgId(actor);
    if (!input.toUserId?.trim()) {
      throw new BadRequestException('toUserId 必填（接班人）');
    }
    // 班次定义必须存在（交接不能挂在一个不存在的班次上）
    const [shift] = await this.db
      .select()
      .from(ewohShift)
      .where(and(eq(ewohShift.orgId, orgId), eq(ewohShift.shiftId, input.shiftId)))
      .limit(1);
    if (!shift) {
      throw new NotFoundException(`班次 ${input.shiftId} 不存在（先登记班次定义）`);
    }
    const openItems = (input.openItems ?? []).filter((i) => i.title?.trim());
    // NO-52a：交接时刻核对"接班班次的责任人"，把快照**存下来**（审计要回答"当时知不知道"，
    // 事后按现状重算会得到不同答案）。核对失败不阻塞交接（快照为 null，交接事实照常落账）。
    let responsibilitySnapshot: Record<string, unknown> | null = null;
    if (this.responsibilities) {
      try {
        // 关键：用**嵌套事务（savepoint）**包住核对查询。实测教训——只 try/catch 是假的
        // "不阻塞"：核对 SQL 一旦报错（当时是 varchar=uuid 类型不匹配），外层事务进入
        // aborted 状态，随后的交接插入照样失败（500）。放进 savepoint 后失败只回滚这一步。
        const snapshot = await this.db.transaction(async () =>
          this.responsibilities!.coverageForShift(orgId, { shiftId: input.shiftId }),
        );
        responsibilitySnapshot = {
          shiftId: snapshot.shiftId,
          shiftUnknown: snapshot.shiftUnknown,
          total: snapshot.total,
          covered: snapshot.covered,
          gaps: snapshot.gaps,
          uncovered: snapshot.uncovered,
          gapDeviceIds: snapshot.devices.filter((d) => !d.covered).map((d) => d.deviceId),
          generatedAt: new Date().toISOString(),
        };
      } catch (error) {
        this.logger.warn(`交接班责任人核对失败（不阻塞交接）: ${String(error)}`);
      }
    }
    const handoverId = input.handoverId?.trim()
      || `HO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 6).toUpperCase()}`;
    const shiftDate = input.shiftDate ?? new Date().toISOString().slice(0, 10);
    const row = {
      orgId,
      handoverId,
      shiftId: input.shiftId,
      shiftDate,
      fromUserId: input.fromUserId ?? null,
      toUserId: input.toUserId,
      openItemsJson: openItems,
      notes: input.notes ?? null,
      status: 'confirmed' as const,
      confirmedAt: new Date(),
      responsibilitySnapshotJson: responsibilitySnapshot,
    };
    let inserted;
    try {
      const result = await this.db.insert(ewohShiftHandover).values(row).returning();
      inserted = result[0];
      await this.recordHandoverEvent(inserted, orgId);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== '23505') throw err;
      const existing = await this.db
        .select()
        .from(ewohShiftHandover)
        .where(and(eq(ewohShiftHandover.orgId, orgId), eq(ewohShiftHandover.handoverId, handoverId)))
        .limit(1);
      if (existing.length === 0) throw err;
      this.logger.debug(`交接幂等重放命中: ${handoverId}`);
      return { record: this.toHandover(existing[0]), created: false };
    }
    return { record: this.toHandover(inserted), created: true };
  }

  async listHandovers(
    actor?: OrgContext,
    opts?: { shiftId?: string; limit?: number },
  ): Promise<ShiftHandover[]> {
    const orgId = this.requireOrgId(actor);
    const conditions = [eq(ewohShiftHandover.orgId, orgId)];
    if (opts?.shiftId) conditions.push(eq(ewohShiftHandover.shiftId, opts.shiftId));
    const rows = await this.db
      .select()
      .from(ewohShiftHandover)
      .where(and(...conditions))
      .orderBy(desc(ewohShiftHandover.shiftDate))
      .limit(Math.min(opts?.limit ?? 50, 200));
    return rows.map((r) => this.toHandover(r));
  }

  /** PG time 列可能带秒（"16:00:00"）；对前端口径统一归一为 HH:mm。 */
  private static normalizeHm(value: string): string {
    return value?.length > 5 ? value.slice(0, 5) : value;
  }

  private toShift(r: typeof ewohShift.$inferSelect): ShiftDefinition {
    return {
      shiftId: r.shiftId,
      name: r.name,
      code: r.code,
      startTime: ShiftService.normalizeHm(r.startTime),
      endTime: ShiftService.normalizeHm(r.endTime),
      crossesMidnight: r.crossesMidnight,
      active: r.active,
      leadUserId: r.leadUserId,
      description: r.description,
    };
  }

  private toHandover(r: typeof ewohShiftHandover.$inferSelect): ShiftHandover {
    return {
      handoverId: r.handoverId,
      shiftId: r.shiftId,
      shiftDate: typeof r.shiftDate === 'string' ? r.shiftDate : String(r.shiftDate),
      fromUserId: r.fromUserId,
      toUserId: r.toUserId,
      openItems: (r.openItemsJson as ShiftHandoverOpenItem[]) ?? [],
      notes: r.notes,
      // NO-52a：交接时刻的责任人核对快照（缺失 = 当时没核对/核对失败，页面要如实说明）
      responsibilitySnapshot:
        (r.responsibilitySnapshotJson as ShiftHandover['responsibilitySnapshot']) ?? null,
      status: r.status === 'pending' ? 'pending' : 'confirmed',
      confirmedAt: r.confirmedAt ? r.confirmedAt.toISOString() : null,
    };
  }

  /** ShiftHandoverRecorded 目录事件（Canonical 信封，standalone_066 列）。 */
  private async recordHandoverEvent(
    row: typeof ewohShiftHandover.$inferSelect,
    orgId: string,
  ) {
    const eventId = `EVT-${Math.floor(Date.now() / 1000)}-${randomUUID().slice(0, 8)}`;
    const now = new Date();
    const nowIso = now.toISOString();
    const envelope = buildEventEnvelope({
      eventId,
      eventType: 'ShiftHandoverRecorded',
      occurredAt: nowIso,
      observedAt: nowIso,
      receivedAt: nowIso,
      source: 'cloud:shift',
      subject: row.handoverId,
      correlationId: currentTraceId() ?? null,
    });
    const evidence = envelopeForEvidence(envelope);
    await this.db.insert(ewohEvent).values({
      eventId,
      eventType: 'ShiftHandoverRecorded',
      eventCode: 'SHIFT_HANDOVER_RECORDED',
      severity: 'low',
      title: `ShiftHandoverRecorded: ${row.shiftId} ${row.shiftDate}`,
      status: 'closed',
      sourceType: 'shift',
      orgId,
      createdAt: now,
      occurredAt: now,
      receivedAt: now,
      schemaVersion: '1.0.0',
      evidenceJson: {
        envelope: evidence.envelope,
        envelopeSemantics: evidence.envelopeSemantics,
        handoverId: row.handoverId,
        shiftId: row.shiftId,
        shiftDate: typeof row.shiftDate === 'string' ? row.shiftDate : String(row.shiftDate),
        toUserId: row.toUserId,
        openItemCount: Array.isArray(row.openItemsJson) ? row.openItemsJson.length : 0,
      } as unknown as Record<string, unknown>,
    });
  }
}
