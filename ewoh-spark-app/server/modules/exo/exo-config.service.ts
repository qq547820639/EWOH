import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ewohExoConfig, ewohEvent } from '@server/database/schema';
import { validateExoConfig, type ExoConfigRecord } from '@shared/exo-config';
import { buildEventEnvelope, envelopeForEvidence } from '@shared/event-envelope';
import { currentTraceId } from '@server/common/request-context';

export interface RecordExoConfigInput {
  configId?: string;
  kind: string;
  exoId: string;
  status: string;
  supportMode?: string;
  vendorModeName?: string;
  parameters?: { assistLevel?: number; torqueLimitNm?: number };
  effectiveFrom?: string;
  effectiveTo?: string;
  supersededBy?: string;
  setBy?: string;
  personId?: string;
  fittedAt?: string;
  fitter?: string;
  measuredValues?: Record<string, number>;
  calibrationKind?: string;
  result?: string;
  calibratedAt?: string;
  calibratedBy?: string;
  nextDueAt?: string;
}

/**
 * ExoConfigService（ADR-051/ADR-052 / §7：外骨骼配置事实唯一权威写路径）。
 *
 * - record：契约 fail-closed（validateExoConfig 共享实现 §31——kind/supportMode/
 *   判定事实/时间/auditTrail）→ 幂等（同 org+configId 返回既有行，ADR-033
 *   决策 3 模式）→ insert + audit log + 目录事件 ExoConfigRecorded；
 * - activateProfile：同 (org, exo, mode) 既有 active 全部 CAS→superseded
 *   （supersededBy=新 id，判定事实完整）→ 插入新 active（active 唯一性
 *   服务层强制 + DB 索引辅助）；
 * - list/get：租户作用域（他租户配置绝不可见，§15）；DB RLS 双保险。
 * §2 边界不变：配置事实记录绝不涉及实时助力闭环下发。
 */
@Injectable()
export class ExoConfigService {
  private readonly logger = new Logger(ExoConfigService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async record(input: RecordExoConfigInput, orgId: string): Promise<Record<string, unknown>> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：配置记录必须带租户上下文');
    }
    const configId = input.configId?.trim() || `exo-config:${randomUUID()}`;
    const record: ExoConfigRecord = {
      configId,
      kind: input.kind,
      exoId: input.exoId,
      tenantId: orgId,
      status: input.status,
      supportMode: input.supportMode,
      vendorModeName: input.vendorModeName,
      parameters: input.parameters,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
      supersededBy: input.supersededBy,
      setBy: input.setBy,
      personId: input.personId,
      fittedAt: input.fittedAt,
      fitter: input.fitter,
      measuredValues: input.measuredValues,
      calibrationKind: input.calibrationKind,
      result: input.result,
      calibratedAt: input.calibratedAt,
      calibratedBy: input.calibratedBy,
      nextDueAt: input.nextDueAt,
      auditTrail: [{ actor: input.setBy ?? input.fitter ?? input.calibratedBy ?? 'system', action: 'recorded', at: new Date().toISOString() }],
    };
    const errors = validateExoConfig(record);
    if (errors.length > 0) {
      throw new BadRequestException(`外骨骼配置违反契约: ${errors.join(', ')}`);
    }
    const existing = await this.db
      .select()
      .from(ewohExoConfig)
      .where(and(eq(ewohExoConfig.orgId, orgId), eq(ewohExoConfig.configId, configId)))
      .limit(1);
    if (existing.length > 0) {
      // ADR-033 决策 3：应用层幂等（at-least-once 事件投影安全）
      return this.toRecord(existing[0]);
    }
    const row = {
      orgId,
      configId,
      kind: input.kind,
      exoId: input.exoId,
      status: input.status,
      supportMode: input.supportMode ?? null,
      vendorModeName: input.vendorModeName ?? null,
      parametersJson: (input.parameters ?? null) as unknown as Record<string, unknown> | null,
      effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : null,
      effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
      supersededBy: input.supersededBy ?? null,
      setBy: input.setBy ?? null,
      personId: input.personId ?? null,
      fittedAt: input.fittedAt ? new Date(input.fittedAt) : null,
      fitter: input.fitter ?? null,
      measuredValuesJson: (input.measuredValues ?? null) as unknown as Record<string, unknown> | null,
      calibrationKind: input.calibrationKind ?? null,
      result: input.result ?? null,
      calibratedAt: input.calibratedAt ? new Date(input.calibratedAt) : null,
      calibratedBy: input.calibratedBy ?? null,
      nextDueAt: input.nextDueAt ? new Date(input.nextDueAt) : null,
      recordJson: record as unknown as Record<string, unknown>,
    };
    let inserted;
    try {
      // NEST-431：主事实与观测事件同事务（事件写失败整体回滚，消除
      // “主事实已提交、审计事件丢失仅 warn”的留痕缺口）。
      await this.db.transaction(async (tx) => {
        inserted = (await tx.insert(ewohExoConfig).values(row).returning())[0];
        await this.recordEventOn(tx, inserted, orgId);
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23505') {
        // 同 (org, config_id) 幂等竞争：读回既有行
        const rows = await this.db
          .select()
          .from(ewohExoConfig)
          .where(and(eq(ewohExoConfig.orgId, orgId), eq(ewohExoConfig.configId, configId)))
          .limit(1);
        if (rows.length > 0) return this.toRecord(rows[0]);
        throw new BadRequestException('conflict_exo_config：配置写入冲突');
      }
      throw err;
    }
    return this.toRecord(inserted);
  }

  async activateProfile(
    orgId: string,
    configId: string,
    setBy: string,
  ): Promise<Record<string, unknown>> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：profile 激活必须带租户上下文');
    }
    const rows = await this.db
      .select()
      .from(ewohExoConfig)
      .where(and(eq(ewohExoConfig.orgId, orgId), eq(ewohExoConfig.configId, configId)))
      .limit(1);
    if (rows.length === 0) {
      throw new BadRequestException('exo_config_not_found（不存在或非本租户）');
    }
    const target = rows[0];
    if (target.kind !== 'assist_profile' || !target.supportMode) {
      throw new BadRequestException('仅 assist_profile 可激活（且 supportMode 必填）');
    }
    if (target.status === 'active') {
      // 幂等：已激活返回自身
      return this.toRecord(target);
    }
    // R2-SAM-007：旧 active supersede 循环 + 目标激活 + 事件合并进同一事务
    // （原 supersede 在激活事务外执行，事务失败/进程崩溃会留下“旧 active 已
    // superseded、新 active 未激活”的零 active 半态）。失败整体回滚。
    // NEST-431：激活主事实与观测事件同事务（沿袭既有模式）。
    const nowIso = new Date().toISOString();
    const updated = await this.db.transaction(async (tx) => {
      const active = await tx
        .select()
        .from(ewohExoConfig)
        .where(
          and(
            eq(ewohExoConfig.orgId, orgId),
            eq(ewohExoConfig.exoId, target.exoId),
            eq(ewohExoConfig.kind, 'assist_profile'),
            eq(ewohExoConfig.supportMode, target.supportMode),
            eq(ewohExoConfig.status, 'active'),
          ),
        );
      for (const row of active) {
        await tx
          .update(ewohExoConfig)
          .set({
            status: 'superseded',
            supersededBy: configId,
            effectiveTo: new Date(nowIso),
            recordJson: {
              ...(row.recordJson as Record<string, unknown>),
              status: 'superseded',
              supersededBy: configId,
              effectiveTo: nowIso,
            },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(ewohExoConfig.orgId, orgId),
              eq(ewohExoConfig.id, row.id),
              eq(ewohExoConfig.status, 'active'),
            ),
          );
      }
      const activated = (
        await tx
          .update(ewohExoConfig)
          .set({
            status: 'active',
            setBy: setBy?.trim() || target.setBy,
            recordJson: {
              ...(target.recordJson as Record<string, unknown>),
              status: 'active',
              setBy: setBy?.trim() || (target.recordJson as Record<string, unknown>).setBy,
            },
            updatedAt: new Date(),
          })
          .where(and(eq(ewohExoConfig.orgId, orgId), eq(ewohExoConfig.id, target.id)))
          .returning()
      )[0];
      await this.recordEventOn(tx, activated, orgId);
      return activated;
    });
    return this.toRecord(updated);
  }

  async listConfigs(
    orgId: string,
    filters?: { kind?: string; exoId?: string; status?: string },
  ): Promise<Record<string, unknown>[]> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：配置查询必须带租户上下文');
    }
    const conditions = [eq(ewohExoConfig.orgId, orgId)];
    if (filters?.kind) conditions.push(eq(ewohExoConfig.kind, filters.kind));
    if (filters?.exoId) conditions.push(eq(ewohExoConfig.exoId, filters.exoId));
    if (filters?.status) conditions.push(eq(ewohExoConfig.status, filters.status));
    const rows = await this.db
      .select()
      .from(ewohExoConfig)
      .where(and(...conditions))
      .orderBy(desc(ewohExoConfig.createdAt))
      .limit(500);
    return rows.map((r) => this.toRecord(r));
  }

  async getConfig(orgId: string, configId: string): Promise<Record<string, unknown>> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：配置查询必须带租户上下文');
    }
    const rows = await this.db
      .select()
      .from(ewohExoConfig)
      .where(and(eq(ewohExoConfig.orgId, orgId), eq(ewohExoConfig.configId, configId)))
      .limit(1);
    if (rows.length === 0) {
      throw new BadRequestException('exo_config_not_found（不存在或非本租户）');
    }
    return this.toRecord(rows[0]);
  }

  private toRecord(row: typeof ewohExoConfig.$inferSelect): Record<string, unknown> {
    return {
      configId: row.configId,
      kind: row.kind,
      exoId: row.exoId,
      tenantId: row.orgId,
      status: row.status,
      supportMode: row.supportMode ?? undefined,
      vendorModeName: row.vendorModeName ?? undefined,
      parameters: row.parametersJson ?? undefined,
      effectiveFrom: row.effectiveFrom ? row.effectiveFrom.toISOString() : undefined,
      effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString() : undefined,
      supersededBy: row.supersededBy ?? undefined,
      setBy: row.setBy ?? undefined,
      personId: row.personId ?? undefined,
      fittedAt: row.fittedAt ? row.fittedAt.toISOString() : undefined,
      fitter: row.fitter ?? undefined,
      measuredValues: row.measuredValuesJson ?? undefined,
      calibrationKind: row.calibrationKind ?? undefined,
      result: row.result ?? undefined,
      calibratedAt: row.calibratedAt ? row.calibratedAt.toISOString() : undefined,
      calibratedBy: row.calibratedBy ?? undefined,
      nextDueAt: row.nextDueAt ? row.nextDueAt.toISOString() : undefined,
    };
  }

  /**
   * NEST-431：事件写入与主事实同事务执行（executor=事务句柄）。
   * 事件失败 → 事务回滚（主事实不落“无事件”的半态）。
   */
  private async recordEventOn(
    executor: Pick<PostgresJsDatabase, 'insert'>,
    row: typeof ewohExoConfig.$inferSelect,
    orgId: string,
  ) {
    const eventId = `EVT-${Math.floor(Date.now() / 1000)}-${randomUUID().slice(0, 8)}`;
    const now = new Date();
    const nowIso = now.toISOString();
    const envelope = buildEventEnvelope({
      eventId,
      eventType: 'ExoConfigRecorded',
      occurredAt: nowIso,
      observedAt: nowIso,
      receivedAt: nowIso,
      source: 'cloud:exo-config',
      subject: row.configId,
      correlationId: currentTraceId() ?? null,
    });
    const envelopeRecord = envelopeForEvidence(envelope);
    await executor.insert(ewohEvent).values({
      eventId,
      eventType: 'ExoConfigRecorded',
      eventCode: 'EXO_CONFIG_RECORDED',
      severity: 'low',
      title: `ExoConfigRecorded: ${row.configId}`,
      status: 'open',
      sourceType: 'exo-config',
      orgId,
      createdAt: now,
      evidenceJson: {
        configId: row.configId,
        kind: row.kind,
        exoId: row.exoId,
        status: row.status,
        correlationId: currentTraceId() ?? null,
        envelopeRecord: envelopeRecord.envelope,
        envelopeSemantics: envelopeRecord.envelopeSemantics,
      },
    });
  }
}
