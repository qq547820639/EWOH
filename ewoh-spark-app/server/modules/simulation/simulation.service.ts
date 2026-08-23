import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq } from 'drizzle-orm';
import { ewohSimulationRun, ewohEvent } from '@server/database/schema';
import {
  validateSimulationRun,
  evaluateWhatIf,
  evaluateCapacity,
  evaluateLayout,
  evaluateMaterialFlow,
} from '@shared/simulation-run';
import { buildEventEnvelope, envelopeForEvidence } from '@shared/event-envelope';
import { currentTraceId } from '@server/common/request-context';

export interface RunSimulationInput {
  runId?: string;
  kind: string;
  baseRef: { snapshotVersion: number; scenarioId?: string };
  parameters: Record<string, unknown>;
  engineVersion?: string;
}

export const SIMULATION_ENGINE_VERSION = '1.0.0';

/**
 * SimulationService（ADR-025 / NO-12a，§13 Digital Twin Simulation）。
 *
 * - 四类确定性评估器（what_if/capacity/layout/material_flow）——v1 只注册
 *   有真引擎的类型，绝不注册无引擎空类型（§33/§36）；
 * - §13 三层强制之第三层：仿真评估只读 baseRef 快照、绝不写生产
 *   World State 表——本服务唯一写路径 = ewoh_simulation_run；
 * - 契约校验 fail-closed（validateSimulationRun）：isSimulation 必须 true、
 *   completed 必须 results、failed 必须非空 failureReason；
 * - 终态落账 + SimulationRunCreated/Completed 目录事件（59 类）；
 * - 租户边界 orgId + DB 层 RLS（standalone_044）双保险；
 * - 评估器抛错 → 运行失败（failed + failureReason），**绝不静默吞异常**。
 */
@Injectable()
export class SimulationService {
  private readonly logger = new Logger(SimulationService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async run(input: RunSimulationInput, orgId: string) {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：仿真运行必须带租户上下文');
    }
    const kind = String(input.kind ?? '');
    const engineVersion = input.engineVersion?.trim() || SIMULATION_ENGINE_VERSION;
    const runId = input.runId?.trim() || `sim:${randomUUID().slice(0, 12)}`;
    const record: Record<string, unknown> = {
      runId,
      kind,
      status: 'created',
      isSimulation: true,
      baseRef: input.baseRef ?? { snapshotVersion: 0 },
      parameters: input.parameters ?? {},
      engineVersion,
      auditTrail: true,
    };
    const errors = validateSimulationRun(record);
    if (errors.length > 0) {
      throw new BadRequestException(`仿真运行违反契约: ${errors.join(', ')}`);
    }
    // 幂等：同 org+runId 重复提交 → 回读既有运行（运行是一等资产，不重复评估）。
    // NEST-633：select-then-insert 存在 TOCTOU——并发同 runId 双提交原先第二
    // 个以 23505 裸抛；现 onConflictDoNothing + 空返回即回读（数据库裁决）。
    const existing = await this.db
      .select()
      .from(ewohSimulationRun)
      .where(and(eq(ewohSimulationRun.orgId, orgId), eq(ewohSimulationRun.runId, runId)))
      .limit(1);
    if (existing.length > 0) {
      this.logger.debug(`仿真幂等命中: ${runId}`);
      return { run: this.toRun(existing[0]), created: false };
    }

    const row = {
      orgId,
      runId,
      kind,
      status: 'created' as const,
      isSimulation: true,
      baseRefJson: record.baseRef as Record<string, unknown>,
      parametersJson: record.parameters as Record<string, unknown>,
      resultsJson: null,
      failureReason: null,
      engineVersion,
      recordJson: record,
    };
    let inserted;
    try {
      const result = await this.db
        .insert(ewohSimulationRun)
        .values(row)
        .onConflictDoNothing({ target: [ewohSimulationRun.orgId, ewohSimulationRun.runId] })
        .returning();
      if (result.length === 0) {
        // 并发同 (orgId, runId) 已入库 → 回读（不重复评估、不裸抛 23505）。
        const concurrent = await this.db
          .select()
          .from(ewohSimulationRun)
          .where(and(eq(ewohSimulationRun.orgId, orgId), eq(ewohSimulationRun.runId, runId)))
          .limit(1);
        if (concurrent.length === 0) throw new Error('simulation_run_insert_failed');
        this.logger.debug(`仿真并发幂等命中: ${runId}`);
        return { run: this.toRun(concurrent[0]), created: false };
      }
      inserted = result[0];
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== '23505') throw err;
      const concurrent = await this.db
        .select()
        .from(ewohSimulationRun)
        .where(and(eq(ewohSimulationRun.orgId, orgId), eq(ewohSimulationRun.runId, runId)))
        .limit(1);
      if (concurrent.length === 0) throw err;
      this.logger.debug(`仿真并发幂等命中（23505）: ${runId}`);
      return { run: this.toRun(concurrent[0]), created: false };
    }
    await this.recordEvent(inserted, orgId, 'SimulationRunCreated', 'created');

    // 确定性评估（fail-closed：评估器抛错 → failed 终态，失败理由显式留痕）。
    let results: Record<string, unknown> | null = null;
    let failureReason: string | null = null;
    try {
      results = this.evaluate(kind, record.parameters as Record<string, unknown>);
    } catch (err) {
      failureReason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`仿真评估失败 ${runId}/${kind}: ${failureReason}`);
    }
    const terminalStatus = results != null ? 'completed' : 'failed';
    const updated = (
      await this.db
        .update(ewohSimulationRun)
        .set({
          status: terminalStatus,
          resultsJson: results,
          failureReason,
          recordJson: {
            ...record,
            status: terminalStatus,
            results: results ?? undefined,
            failureReason: failureReason ?? undefined,
          },
          updatedAt: new Date(),
        })
        .where(and(eq(ewohSimulationRun.orgId, orgId), eq(ewohSimulationRun.id, inserted.id)))
        .returning()
    )[0];
    await this.recordEvent(updated, orgId, 'SimulationRunCompleted', terminalStatus);
    return { run: this.toRun(updated), created: true };
  }

  async listRuns(orgId: string, filters?: { kind?: string; status?: string }) {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：仿真查询必须带租户上下文');
    }
    const conditions = [eq(ewohSimulationRun.orgId, orgId)];
    if (filters?.kind) conditions.push(eq(ewohSimulationRun.kind, filters.kind));
    if (filters?.status) conditions.push(eq(ewohSimulationRun.status, filters.status));
    const rows = await this.db
      .select()
      .from(ewohSimulationRun)
      .where(and(...conditions))
      .orderBy(desc(ewohSimulationRun.createdAt))
      .limit(500);
    return rows.map((r) => this.toRun(r));
  }

  async getRun(orgId: string, runId: string) {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：仿真查询必须带租户上下文');
    }
    const rows = await this.db
      .select()
      .from(ewohSimulationRun)
      .where(and(eq(ewohSimulationRun.orgId, orgId), eq(ewohSimulationRun.runId, runId)))
      .limit(1);
    if (rows.length === 0) {
      throw new BadRequestException('simulation_run_not_found（不存在或非本租户）');
    }
    return this.toRun(rows[0]);
  }

  /** 评估器矩阵分发（ADR-025）：未知 kind 在上游契约校验已被拒绝，此处兜底 fail-closed。 */
  private evaluate(kind: string, parameters: Record<string, unknown>): Record<string, unknown> {
    switch (kind) {
      case 'what_if': {
        const baseFacts = parameters.baseFacts;
        const deltaFacts = parameters.deltaFacts;
        if (!Array.isArray(baseFacts) || !Array.isArray(deltaFacts)) {
          throw new Error('参数契约违规：what_if 必须提供 baseFacts/deltaFacts 数组');
        }
        return evaluateWhatIf(currentTraceId() ?? 'trace:simulation:unknown', baseFacts, deltaFacts) as unknown as Record<string, unknown>;
      }
      case 'capacity': {
        const stations = parameters.stations;
        const demand = parameters.demandPerHour;
        if (!Array.isArray(stations) || typeof demand !== 'number') {
          throw new Error('参数契约违规：capacity 必须提供 stations 数组 + demandPerHour 数值');
        }
        return evaluateCapacity(stations, demand) as unknown as Record<string, unknown>;
      }
      case 'layout': {
        const stations = parameters.stations;
        const moves = parameters.moves;
        if (!Array.isArray(stations) || !Array.isArray(moves)) {
          throw new Error('参数契约违规：layout 必须提供 stations/moves 数组');
        }
        return evaluateLayout(stations, moves) as unknown as Record<string, unknown>;
      }
      case 'material_flow': {
        const stations = parameters.stations;
        if (!Array.isArray(stations)) {
          throw new Error('参数契约违规：material_flow 必须提供 stations 数组');
        }
        return evaluateMaterialFlow(stations) as unknown as Record<string, unknown>;
      }
      default:
        throw new Error(`unknown_kind:${kind}`);
    }
  }

  private toRun(row: typeof ewohSimulationRun.$inferSelect): Record<string, unknown> {
    return {
      runId: row.runId,
      kind: row.kind,
      status: row.status,
      isSimulation: row.isSimulation,
      baseRef: row.baseRefJson,
      parameters: row.parametersJson,
      results: row.resultsJson ?? undefined,
      failureReason: row.failureReason ?? undefined,
      engineVersion: row.engineVersion,
      auditTrail: true,
    };
  }

  private async recordEvent(
    row: typeof ewohSimulationRun.$inferSelect,
    orgId: string,
    eventType: 'SimulationRunCreated' | 'SimulationRunCompleted',
    terminalStatus: string,
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
      source: 'cloud:simulation',
      subject: row.runId,
      correlationId: currentTraceId() ?? null,
    });
    const envelopeRecord = envelopeForEvidence(envelope);
    await this.db.insert(ewohEvent).values({
      eventId,
      eventType,
      eventCode: eventType === 'SimulationRunCreated' ? 'SIMULATION_RUN_CREATED' : 'SIMULATION_RUN_COMPLETED',
      severity: 'low',
      title: `${eventType}: ${row.kind} ${row.runId}`,
      status: 'open',
      sourceType: 'simulation',
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
        runId: row.runId,
        kind: row.kind,
        status: terminalStatus,
        isSimulation: row.isSimulation,
        baseRef: row.baseRefJson,
        results: row.resultsJson ?? undefined,
        failureReason: row.failureReason ?? undefined,
        correlationId: currentTraceId() ?? null,
        envelopeRecord: envelopeRecord.envelope,
        envelopeSemantics: envelopeRecord.envelopeSemantics,
      },
    });
  }
}
