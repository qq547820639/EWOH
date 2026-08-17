import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, sql, gte, lte, inArray } from 'drizzle-orm';
import { ewohLearningEvaluation, ewohEvent, ewohAiSuggestion, ewohSchedulingFeedback } from '@server/database/schema';
import { validateLearningEvaluation, LEARNING_ENGINE_VERSION } from '@shared/learning-evaluation';
import { buildEventEnvelope, envelopeForEvidence } from '@shared/event-envelope';
import { currentTraceId } from '@server/common/request-context';
import { KpiService } from '../scheduler/kpi.service';

export interface EvaluateLearningInput {
  evaluationType?: 'periodic' | 'on_demand';
  periodStartMs?: number;
  periodEndMs?: number;
}

/**
 * LearningService（ADR-021 / NO-09a，Phase 12 Continuous Learning Loop v1）。
 *
 * - 每 (org, 周期) 七项学习指标统一快照（§28）——Decision→Outcome 映射事实层；
 * - 指标来源全部为真实事实（决策 2）：
 *     recommendationAcceptanceRate = ewoh_ai_suggestion.plan_content 非空比
 *     （A2 建议 → A3 方案 = 接受）；planSuccessRate/taskDelayP95Ms/
 *     schedulerQualityRate = KpiService 真实聚合复用（completion/lateness/
 *     heuristicFallback）；riskOutcomeRate = ewoh_event severity∈{L1,L2}
 *     status∉{open} 比；humanOverrideRate = feedback override_count 比；
 *     modelAccuracy = null（显式 unknown，台账无 outcome 标注，§10 绝不伪造）；
 * - 契约校验 fail-closed（validateLearningEvaluation）→ 幂等落账
 *   （evalId=le:{type}:{periodStart} 确定性推导，唯一键冲突回读不重复发事件）
 *   → LearningEvaluationRecorded 目录事件（56 类）；
 * - v1 观测层：绝不自动回写生产调度规则/策略（§2 安全边界）；
 * - 租户边界 orgId + DB 层 RLS（standalone_041）双保险。
 */
@Injectable()
export class LearningService {
  private readonly logger = new Logger(LearningService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly kpiService: KpiService,
  ) {}

  async evaluate(input: EvaluateLearningInput, orgId: string) {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：学习评估必须带租户上下文');
    }
    const endMs = input.periodEndMs ?? Date.now();
    const startMs = input.periodStartMs ?? endMs - 24 * 60 * 60 * 1000;
    if (startMs > endMs) {
      throw new BadRequestException('periodStart 不得晚于 periodEnd');
    }
    const evaluationType = input.evaluationType ?? 'periodic';
    if (evaluationType !== 'periodic' && evaluationType !== 'on_demand') {
      throw new BadRequestException(`unknown_evaluation_type:${evaluationType}`);
    }
    const periodStart = new Date(startMs).toISOString();
    const periodEnd = new Date(endMs).toISOString();
    const evalId = `le:${evaluationType}:${periodStart}`;

    const metrics: Record<string, number | null> = {
      recommendationAcceptanceRate: await this.aggregateAcceptance(startMs, endMs, orgId),
      planSuccessRate: null,
      taskDelayP95Ms: null,
      riskOutcomeRate: await this.aggregateRiskOutcome(startMs, endMs, orgId),
      humanOverrideRate: await this.aggregateOverrideRate(startMs, endMs, orgId),
      modelAccuracy: null, // 显式 unknown：台账无 outcome 标注（§10，绝不伪造）
      schedulerQualityRate: null,
    };
    // KpiService 真实聚合复用（聚合失败 → 显式 null，不伪造）
    try {
      const kpi = await this.kpiService.aggregate({
        orgId,
        periodStartMs: startMs,
        periodEndMs: endMs,
      });
      metrics.planSuccessRate = kpi.delivery.completionRate;
      metrics.taskDelayP95Ms = kpi.delivery.latenessP95Ms;
      metrics.schedulerQualityRate = kpi.solver.heuristicFallbackRate;
    } catch (error) {
      this.logger.warn(`调度 KPI 聚合失败（指标显式 null，不伪造）: ${String(error)}`);
    }

    const basis = [
      'ewoh_ai_suggestion.plan_content（A2→A3 接受率）',
      'KpiService delivery（completion/lateness，真实聚合复用）',
      'ewoh_event severity/status（L1-L2 结局）',
      'ewoh_scheduling_feedback override_count',
      'modelAccuracy=unknown（台账无 outcome 标注，§10）',
      'KpiService solver.heuristicFallbackRate',
    ];
    const record: Record<string, unknown> = {
      evalId,
      orgId,
      evaluationType,
      periodStart,
      periodEnd,
      engineVersion: LEARNING_ENGINE_VERSION,
      metrics,
      basis,
      auditTrail: true,
    };
    const errors = validateLearningEvaluation(record);
    if (errors.length > 0) {
      throw new BadRequestException(`学习评估违反契约: ${errors.join(', ')}`);
    }
    const row = {
      orgId,
      evalId,
      evaluationType,
      periodStart: new Date(periodStart),
      periodEnd: new Date(periodEnd),
      engineVersion: LEARNING_ENGINE_VERSION,
      metricsJson: metrics,
      basisJson: basis,
      resultJson: record,
    };
    let inserted;
    try {
      // NEST-345：台账行 + 目录事件同事务（原先事件失败时评估已落库）。
      const result = await this.db.transaction(async (tx) => {
        const rows = await tx.insert(ewohLearningEvaluation).values(row).returning();
        await this.recordEvent(tx, rows[0], orgId);
        return rows;
      });
      inserted = result[0];
    } catch (err) {
      // 幂等重评估：唯一 (org_id, eval_id) 冲突 → 返回既有行，不重复发事件
      const code = (err as { code?: string }).code;
      if (code !== '23505') throw err;
      const existing = await this.db
        .select()
        .from(ewohLearningEvaluation)
        .where(
          and(eq(ewohLearningEvaluation.orgId, orgId), eq(ewohLearningEvaluation.evalId, evalId)),
        )
        .limit(1);
      if (existing.length === 0) throw err;
      this.logger.debug(`学习评估幂等重放命中: ${evalId}`);
      return { record: this.toEvaluation(existing[0]), created: false };
    }
    return { record: this.toEvaluation(inserted), created: true };
  }

  async listEvaluations(orgId: string, limit = 100) {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：学习评估查询必须带租户上下文');
    }
    const rows = await this.db
      .select()
      .from(ewohLearningEvaluation)
      .where(eq(ewohLearningEvaluation.orgId, orgId))
      .orderBy(desc(ewohLearningEvaluation.periodStart))
      .limit(Math.min(limit, 500));
    return rows.map((r) => this.toEvaluation(r));
  }

  async latest(orgId: string): Promise<Record<string, unknown> | null> {
    const rows = await this.db
      .select()
      .from(ewohLearningEvaluation)
      .where(eq(ewohLearningEvaluation.orgId, orgId))
      .orderBy(desc(ewohLearningEvaluation.periodStart))
      .limit(1);
    if (rows.length === 0) return null;
    return this.toEvaluation(rows[0]);
  }

  // ── 真实事实聚合（无数据 → null，绝不伪造） ──────────────────────────────

  /** A2 建议 → A3 方案（plan_content 非空）= 接受。 */
  private async aggregateAcceptance(startMs: number, endMs: number, orgId: string): Promise<number | null> {
    try {
      // ADR-078：drizzle 类型安全 + org 过滤（跨租户聚合关闭，§15/§16）。
      const rows = await this.db
        .select({
          total: sql`count(*)::int`,
          accepted: sql`count(*) filter (where plan_content is not null)::int`,
        })
        .from(ewohAiSuggestion)
        .where(
          and(
            gte(ewohAiSuggestion.createdAt, new Date(startMs)),
            lte(ewohAiSuggestion.createdAt, new Date(endMs)),
            eq(ewohAiSuggestion.orgId, orgId),
          ),
        );
      const row = rows[0] as { total: number; accepted: number } | undefined;
      const total = Number(row?.total ?? 0);
      if (total === 0) return null;
      return Number(row?.accepted ?? 0) / total;
    } catch (error) {
      this.logger.warn(`acceptance 聚合失败: ${String(error)}`);
      return null;
    }
  }

  /** critical/high 事件结局（status ∉ {open}）= 处置（ADR-027 规范词表）。 */
  private async aggregateRiskOutcome(startMs: number, endMs: number, orgId: string): Promise<number | null> {
    try {
      // ADR-078：drizzle 类型安全（org 过滤语义不变；ADR-027 双词表过渡保留）。
      const rows = await this.db
        .select({
          closed: sql`count(*) filter (where status <> 'open')::int`,
          total: sql`count(*)::int`,
        })
        .from(ewohEvent)
        .where(
          and(
            inArray(ewohEvent.severity, ['critical', 'high', 'L1', 'L2']),
            gte(ewohEvent.createdAt, new Date(startMs)),
            lte(ewohEvent.createdAt, new Date(endMs)),
            eq(ewohEvent.orgId, orgId),
          ),
        );
      const row = rows[0] as { closed: number; total: number } | undefined;
      const total = Number(row?.total ?? 0);
      if (total === 0) return null;
      return Number(row?.closed ?? 0) / total;
    } catch (error) {
      this.logger.warn(`riskOutcome 聚合失败: ${String(error)}`);
      return null;
    }
  }

  /** 人工覆盖计数 / 反馈行数。 */
  private async aggregateOverrideRate(startMs: number, endMs: number, orgId: string): Promise<number | null> {
    try {
      // ADR-078：drizzle 类型安全 + org 过滤（跨租户聚合关闭，§15/§16）。
      const rows = await this.db
        .select({
          overrides: sql`coalesce(sum(override_count), 0)::int`,
          total: sql`count(*)::int`,
        })
        .from(ewohSchedulingFeedback)
        .where(
          and(
            gte(ewohSchedulingFeedback.ts, new Date(startMs)),
            lte(ewohSchedulingFeedback.ts, new Date(endMs)),
            eq(ewohSchedulingFeedback.orgId, orgId),
          ),
        );
      const row = rows[0] as { overrides: number; total: number } | undefined;
      const total = Number(row?.total ?? 0);
      if (total === 0) return null;
      return Number(row?.overrides ?? 0) / total;
    } catch (error) {
      this.logger.warn(`overrideRate 聚合失败: ${String(error)}`);
      return null;
    }
  }

  private toEvaluation(row: typeof ewohLearningEvaluation.$inferSelect): Record<string, unknown> {
    return {
      evalId: row.evalId,
      orgId: row.orgId,
      evaluationType: row.evaluationType,
      periodStart: row.periodStart.toISOString(),
      periodEnd: row.periodEnd.toISOString(),
      engineVersion: row.engineVersion,
      metrics: row.metricsJson,
      basis: row.basisJson,
      auditTrail: true,
    };
  }

  /** NEST-345：接受 db 或事务（评估行 + 事件同事务提交）。 */
  private async recordEvent(
    db: Pick<PostgresJsDatabase, 'insert'>,
    row: typeof ewohLearningEvaluation.$inferSelect,
    orgId: string,
  ) {
    const eventId = `EVT-${Math.floor(Date.now() / 1000)}-${randomUUID().slice(0, 8)}`;
    const now = new Date();
    const nowIso = now.toISOString();
    const envelope = buildEventEnvelope({
      eventId,
      eventType: 'LearningEvaluationRecorded',
      occurredAt: nowIso,
      observedAt: nowIso,
      receivedAt: nowIso,
      source: 'cloud:learning',
      subject: row.evalId,
      correlationId: currentTraceId() ?? null,
    });
    const envelopeRecord = envelopeForEvidence(envelope);
    await db.insert(ewohEvent).values({
      eventId,
      eventType: 'LearningEvaluationRecorded',
      eventCode: 'LEARNING_EVALUATION_RECORDED',
      severity: 'low',
      title: `LearningEvaluationRecorded: ${row.evaluationType} ${row.evalId}`,
      status: 'open',
      sourceType: 'learning',
      orgId,
      createdAt: now,
      evidenceJson: {
        evalId: row.evalId,
        evaluationType: row.evaluationType,
        periodStart: row.periodStart.toISOString(),
        periodEnd: row.periodEnd.toISOString(),
        metrics: row.metricsJson,
        envelope: envelopeRecord.envelope,
        envelopeSemantics: envelopeRecord.envelopeSemantics,
      },
    });
  }
}
