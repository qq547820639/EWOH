import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, eq } from 'drizzle-orm';
import { ewohQualityFinding, ewohEvent } from '@server/database/schema';
import { deriveWorkOrderId } from '@server/common/workorder-ids';
import {
  qualityTransitionAllowed,
  validateQualityFinding,
  type QualityStatus,
} from '@shared/quality';
import { normalizeSeverity } from '@shared/risk';
import { buildEventEnvelope, envelopeForEvidence } from '@shared/event-envelope';
import { WorkOrderService } from '../workorder/workorder.service';

export interface CreateFindingInput {
  findingId: string;
  findingType: string;
  severity: string;
  links?: string[];
  evidenceId?: string | null;
}

export interface TransitionFindingInput {
  to: string;
  disposition?: string | null;
}

/**
 * Quality 服务（ADR-010 / NO-05b）：质量发现事实的注册与生命周期转移。
 *
 * - 契约校验 fail-closed（shared/quality.ts validateQualityFinding，与边缘 Python 同向量）；
 * - 转移按契约 open→under_review→dispositioned→closed；dispositioned 必须带
 *   disposition∈{accept,rework,scrap,return}（否则拒绝，与 standalone_034 CHECK 一致）；
 * - 事件落库：创建 → QualityFindingDetected；dispositioned → QualityFindingDispositioned
 *   （信封遵循 ADR-009，eventType 对齐 contracts/events/event-catalog.yaml）；
 *   disposition=rework（links 有落点）→ WorkOrderService 唯一权威写路径创建工单 +
 *   WorkOrderCreated（ADR-012 / NO-05e-b）；
 * - 租户边界 orgId + DB 层 RLS（standalone_034）双保险。
 */
@Injectable()
export class QualityService {
  private readonly logger = new Logger(QualityService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly workOrderService: WorkOrderService,
  ) {}

  async createFinding(input: CreateFindingInput, orgId: string) {
    if (!orgId) throw new BadRequestException('orgId 缺失：质量发现注册必须带租户上下文');
    const errors = validateQualityFinding({
      findingId: input.findingId,
      findingType: input.findingType,
      severity: input.severity,
      status: 'open',
      links: input.links ?? [],
    });
    if (errors.length > 0) {
      throw new BadRequestException(`质量发现违反契约: ${errors.join(', ')}`);
    }
    const row = {
      orgId,
      findingId: input.findingId,
      findingType: input.findingType,
      severity: normalizeSeverity(input.severity),
      status: 'open' as QualityStatus,
      disposition: null,
      links: input.links ?? [],
      detectedAt: new Date(),
      dispositionedAt: null,
      evidenceId: input.evidenceId ?? null,
    };
    const inserted = await this.db.insert(ewohQualityFinding).values(row).returning();
    await this.recordEvent(orgId, inserted[0], 'QualityFindingDetected');
    return inserted[0];
  }

  async listFindings(orgId: string, filters?: { status?: string }) {
    if (!orgId) throw new BadRequestException('orgId 缺失：质量发现查询必须带租户上下文');
    const conditions = [eq(ewohQualityFinding.orgId, orgId)];
    if (filters?.status) conditions.push(eq(ewohQualityFinding.status, filters.status));
    const rows = await this.db
      .select()
      .from(ewohQualityFinding)
      .where(and(...conditions))
      .limit(500);
    return rows.map((r) => ({
      ...r,
      detectedAt: r.detectedAt.toISOString(),
      dispositionedAt: r.dispositionedAt ? r.dispositionedAt.toISOString() : null,
    }));
  }

  async transitionFinding(findingId: string, input: TransitionFindingInput, orgId: string) {
    if (!orgId) throw new BadRequestException('orgId 缺失：质量发现转移必须带租户上下文');
    const rows = await this.db
      .select()
      .from(ewohQualityFinding)
      .where(
        and(
          eq(ewohQualityFinding.orgId, orgId),
          eq(ewohQualityFinding.findingId, findingId),
        ),
      );
    if (rows.length === 0) throw new BadRequestException('质量发现不存在');
    const current = rows[0];
    if (!qualityTransitionAllowed(current.status, input.to)) {
      throw new BadRequestException(
        `非法状态转移 ${current.status} → ${input.to}（契约 lifecycle 顺序强制）`,
      );
    }
    // dispositioned 必须带合法 disposition（契约 + standalone_034 CHECK 双强制）。
    const next = {
      findingId: current.findingId,
      findingType: current.findingType,
      severity: current.severity,
      status: input.to,
      links: current.links ?? [],
      disposition: input.to === 'dispositioned' ? (input.disposition ?? null) : current.disposition,
    };
    const errors = validateQualityFinding(next);
    if (errors.length > 0) {
      throw new BadRequestException(`质量发现转移违反契约: ${errors.join(', ')}`);
    }
    const set: Record<string, unknown> = { status: input.to, updatedAt: new Date() };
    if (input.to === 'dispositioned') {
      set.disposition = input.disposition;
      set.dispositionedAt = new Date();
    }
    // NEST-627：更新加 eq(status=current.status) CAS + returning——
    // 并发双转移只有一个成功，败者显式冲突（原先 0 行命中静默无感知）。
    const updatedRows = await this.db
      .update(ewohQualityFinding)
      .set(set)
      .where(
        and(
          eq(ewohQualityFinding.orgId, orgId),
          eq(ewohQualityFinding.id, current.id),
          eq(ewohQualityFinding.status, current.status),
        ),
      )
      .returning();
    if (updatedRows.length === 0) {
      throw new BadRequestException(
        `质量发现状态已被并发修改（${current.status} → ${input.to} CAS 未命中）`,
      );
    }
    if (input.to === 'dispositioned') {
      await this.recordEvent(orgId, updatedRows[0], 'QualityFindingDispositioned');
      // NO-05e（ADR-012）：rework 处置 → WorkOrderService 唯一权威写路径创建
      // 真实工单行 + WorkOrderCreated（subject 取 links 首个规范身份；links 为空
      // 则无执行落点，记 warn 不伪造工单）。
      if (input.disposition === 'rework') {
        const subject = (current.links ?? [])[0];
        if (subject) {
          await this.workOrderService.createWorkOrder(
            {
              workOrderId: deriveWorkOrderId('quality_finding', current.findingId),
              workOrderType: 'quality_rework',
              origin: { kind: 'quality_finding', id: current.findingId },
              subjectEntityId: subject,
              severity: current.severity,
            },
            orgId,
          );
        } else {
          this.logger.warn(
            `质量发现 disposition=rework 但 links 为空，无法确定工单执行落点（不伪造工单）: ${current.findingId}`,
          );
        }
      }
    }
    return { findingId, from: current.status, to: input.to, disposition: set.disposition ?? null };
  }

  private async recordEvent(
    orgId: string,
    row: typeof ewohQualityFinding.$inferSelect,
    eventType: 'QualityFindingDetected' | 'QualityFindingDispositioned',
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
      source: 'cloud:quality',
      subject: row.findingId,
    });
    const envelopeRecord = envelopeForEvidence(envelope);
    await this.db.insert(ewohEvent).values({
      eventId,
      eventType,
      eventCode: eventType === 'QualityFindingDetected' ? 'QF_DETECTED' : 'QF_DISPOSITIONED',
      severity: row.severity,
      title: `${eventType}: ${row.findingType} (${row.findingId})`,
      status: 'open',
      sourceType: 'quality',
      orgId,
      createdAt: now,
      evidenceJson: {
        findingId: row.findingId,
        findingType: row.findingType,
        ...(row.disposition ? { disposition: row.disposition } : {}),
        envelope: envelopeRecord.envelope,
        envelopeSemantics: envelopeRecord.envelopeSemantics,
      },
    });
  }
}
