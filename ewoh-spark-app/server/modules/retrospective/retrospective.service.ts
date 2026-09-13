import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, gte, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  ewohEvent,
  ewohOutcomeAnnotation,
  ewohRetrospective,
  ewohSchedulePlan,
  ewohSchedulingExecution,
  ewohSchedulingFeedback,
  ewohSchedulingPlanAssignment,
  ewohDataQualityConfirmation as ewohDataQualityConfirmationTable,
} from '@server/database/schema';
import type { OrgContext } from '../shared/org-context.interceptor';
import { buildGucSettings } from '../shared/org-context.interceptor';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { AuditService } from '../shared/audit.service';
import { ArkService } from '../ai/ark.service';
import { buildEventEnvelope, envelopeForEvidence } from '@shared/event-envelope';
import { currentTraceId } from '@server/common/request-context';
import {
  RETROSPECTIVE_SCOPES,
  validateRetrospectiveRecord,
  type AssembledRetrospective,
  type NarrativeSource,
  type RetrospectiveLesson,
  type RetrospectiveRecord,
  type RetrospectiveScope,
  type RetrospectiveStatus,
} from '@shared/retrospective';

/** 触发事件回溯窗口：方案生成前 24h 内、引用触发实体的最早→最新匹配。 */
const TRIGGER_LOOKBACK_MS = 24 * 3_600_000;
/** 同触发候选方案聚合窗口（同一异常触发并行生成的备选）。 */
const ALTERNATIVE_WINDOW_MS = 3_600_000;

/**
 * 复盘/运行记忆服务（standalone_075，DR-3）。
 *
 * 把"感知→数据质量→影响→决策→授权→执行→反馈"组装成一条可追溯的运行记忆：
 * - 每段只引用既有台账证据（evidenceIds），不复制事实、不造第二事实源；
 * - 缺失环节显式进 gaps（原则 7：没有数据就说没有，绝不编造）；
 * - narrative：Ark LLM 总结 + 规则模板兜底（narrationSource 双路留痕，
 *   与 scheduling-narrator 同纪律——LLM 调用在 PG 事务外，不占连接）；
 * - 同一 target 至多一条非 superseded 复盘（SQL 部分唯一索引 + 服务端 upsert：
 *   重新组装 = 覆盖 draft/published 为新 draft，旧 published → superseded）。
 */
@Injectable()
export class RetrospectiveService {
  private readonly logger = new Logger(RetrospectiveService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
    private readonly auditService: AuditService,
    // LLM 总结为可选装配：未配置/失败时规则模板兜底（narrationSource 留痕）。
    @Optional() private readonly arkService?: ArkService,
  ) {}

  private requireActor(actor?: OrgContext): OrgContext {
    if (!actor?.primaryOrgId?.trim() || !actor.userId?.trim()) {
      throw new ForbiddenException('复盘操作必须带认证租户上下文');
    }
    return actor;
  }

  /**
   * 从调度方案组装复盘（闭环第⑩步）。幂等：同 target 已有有效复盘 →
   * 旧 published 置 superseded，新 draft 落账（重新组装语义）。
   */
  async assembleFromPlan(planId: string, actor?: OrgContext) {
    const ctx = this.requireActor(actor);
    const [plan] = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(
        and(
          eq(ewohSchedulePlan.planId, planId),
          or(
            isNull(ewohSchedulePlan.orgId),
            eq(ewohSchedulePlan.orgId, ctx.primaryOrgId),
          ),
        ),
      )
      .limit(1);
    if (!plan) {
      throw new NotFoundException(`方案 ${planId} 不存在（同租户内）`);
    }

    const assignments = await this.db
      .select()
      .from(ewohSchedulingPlanAssignment)
      .where(eq(ewohSchedulingPlanAssignment.planId, planId));

    const triggerEvent = await this.findTriggerEvent(plan, ctx.primaryOrgId);
    const dataQualityConfirmations = triggerEvent
      ? await this.db
          .select()
          .from(ewohDataQualityConfirmationTable)
          .where(
            and(
              eq(ewohDataQualityConfirmationTable.orgId, ctx.primaryOrgId),
              eq(ewohDataQualityConfirmationTable.eventId, triggerEvent.eventId),
            ),
          )
          .limit(1)
      : [];
    const alternatives = await this.findAlternatives(plan, ctx.primaryOrgId);
    const executions = await this.db
      .select()
      .from(ewohSchedulingExecution)
      .where(
        and(
          eq(ewohSchedulingExecution.planId, planId),
          eq(ewohSchedulingExecution.orgId, ctx.primaryOrgId),
        ),
      );
    const feedback = await this.db
      .select()
      .from(ewohSchedulingFeedback)
      .where(eq(ewohSchedulingFeedback.planId, planId));
    const annotations = await this.db
      .select()
      .from(ewohOutcomeAnnotation)
      .where(
        and(
          eq(ewohOutcomeAnnotation.orgId, ctx.primaryOrgId),
          eq(ewohOutcomeAnnotation.targetType, 'plan'),
          eq(ewohOutcomeAnnotation.targetId, planId),
        ),
      );

    const assembled = this.buildAssembled({
      plan,
      assignments,
      triggerEvent,
      dqConfirmation: dataQualityConfirmations[0] ?? null,
      alternatives,
      executions,
      feedback,
      annotations,
    });
    const lessons = this.deriveLessons(assembled);

    // AI 总结（LLM 在事务外调用，失败回落规则模板）。
    const narrativeResult = await this.composeNarrative(assembled, plan.planName ?? planId);
    const record: RetrospectiveRecord = {
      retrospectiveId: `RETRO-${randomUUID().slice(0, 8).toUpperCase()}`,
      scope: 'plan',
      targetId: planId,
      title: `复盘：${plan.planName ?? planId}`,
      periodStart: plan.createdAt ? plan.createdAt.toISOString() : null,
      periodEnd: new Date().toISOString(),
      triggerEventId: triggerEvent?.eventId ?? null,
      status: 'draft',
      assembled,
      narrative: narrativeResult.text,
      narrativeSource: narrativeResult.source,
      narrativeModel: narrativeResult.model,
      publishedAt: null,
      createdBy: ctx.userId,
      createdAt: new Date().toISOString(),
    };
    // lessons 并入 feedback 段（AI 总结 + 人工可改）。
    record.assembled.feedback.lessons = lessons;
    const errors = validateRetrospectiveRecord(record);
    if (errors.length > 0) {
      throw new BadRequestException(`复盘记录违反契约: ${errors.join(', ')}`);
    }

    const saved = await this.persistWithSupersede(record, ctx);
    await this.auditService.appendAuditLog({
      actorId: ctx.userId,
      orgId: ctx.primaryOrgId,
      action: 'retrospective.assemble',
      entityType: 'retrospective',
      entityId: saved.retrospectiveId,
      reason: `scope=plan target=${planId} gaps=${assembled.gaps.length} narrative=${narrativeResult.source}`,
    });
    await this.recordEvent(saved, ctx.primaryOrgId, 'draft');
    return { record: saved, created: true };
  }

  async list(
    actor?: OrgContext,
    opts?: { scope?: string; status?: string; limit?: number },
  ): Promise<RetrospectiveRecord[]> {
    const ctx = this.requireActor(actor);
    const conditions = [eq(ewohRetrospective.orgId, ctx.primaryOrgId)];
    if (opts?.scope) conditions.push(eq(ewohRetrospective.scope, opts.scope));
    if (opts?.status) conditions.push(eq(ewohRetrospective.status, opts.status));
    const rows = await this.db
      .select()
      .from(ewohRetrospective)
      .where(and(...conditions))
      .orderBy(desc(ewohRetrospective.createdAt))
      .limit(Math.min(opts?.limit ?? 50, 200));
    return rows.map((r) => this.toRecord(r));
  }

  async get(retrospectiveId: string, actor?: OrgContext): Promise<RetrospectiveRecord> {
    const ctx = this.requireActor(actor);
    const [row] = await this.db
      .select()
      .from(ewohRetrospective)
      .where(
        and(
          eq(ewohRetrospective.orgId, ctx.primaryOrgId),
          eq(ewohRetrospective.retrospectiveId, retrospectiveId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException(`复盘 ${retrospectiveId} 不存在（同租户内）`);
    return this.toRecord(row);
  }

  /** 发布（draft → published）：运行记忆进入"可被检索引用"的稳定态。 */
  async publish(retrospectiveId: string, actor?: OrgContext) {
    const ctx = this.requireActor(actor);
    const [row] = await this.db
      .update(ewohRetrospective)
      .set({ status: 'published', publishedAt: new Date() })
      .where(
        and(
          eq(ewohRetrospective.orgId, ctx.primaryOrgId),
          eq(ewohRetrospective.retrospectiveId, retrospectiveId),
          eq(ewohRetrospective.status, 'draft'),
        ),
      )
      .returning();
    if (!row) {
      throw new NotFoundException(`复盘 ${retrospectiveId} 不存在或不可发布（仅 draft 可发布）`);
    }
    await this.auditService.appendAuditLog({
      actorId: ctx.userId,
      orgId: ctx.primaryOrgId,
      action: 'retrospective.publish',
      entityType: 'retrospective',
      entityId: retrospectiveId,
    });
    await this.recordEvent(this.toRecord(row), ctx.primaryOrgId, 'published');
    return this.toRecord(row);
  }

  /** 人工修订经验条目（AI 建议可被改写——运行记忆归人所有）。 */
  async updateLessons(
    retrospectiveId: string,
    lessons: RetrospectiveLesson[],
    actor?: OrgContext,
  ) {
    const ctx = this.requireActor(actor);
    if (!Array.isArray(lessons)) {
      throw new BadRequestException('lessons 必须为数组');
    }
    const cleaned = lessons
      .filter((l) => typeof l?.title === 'string' && l.title.trim() && typeof l?.detail === 'string')
      .map((l) => ({
        title: l.title.trim(),
        detail: l.detail,
        severity: (['info', 'warning', 'critical'] as const).includes(l.severity) ? l.severity : 'info',
        evidenceIds: Array.isArray(l.evidenceIds) ? l.evidenceIds : [],
      }));
    const [current] = await this.db
      .select({ assembledJson: ewohRetrospective.assembledJson })
      .from(ewohRetrospective)
      .where(
        and(
          eq(ewohRetrospective.orgId, ctx.primaryOrgId),
          eq(ewohRetrospective.retrospectiveId, retrospectiveId),
        ),
      )
      .limit(1);
    if (!current) throw new NotFoundException(`复盘 ${retrospectiveId} 不存在（同租户内）`);
    // lessons 有两个事实落点：lessons_json（improvement-action 扫描消费）与
    // assembled_json.feedback.lessons（toRecord 读面唯一来源——GET/PATCH 都从
    // assembled 还原）。只写前者会出现"人工修订写成功但读面永远返回 AI 旧条目"
    // 的台账脱节，因此同一 UPDATE 里两处同步。
    const assembledJson = (current.assembledJson ?? {}) as Record<string, unknown>;
    const feedback = (assembledJson.feedback ?? {}) as Record<string, unknown>;
    const nextAssembled = {
      ...assembledJson,
      feedback: { ...feedback, lessons: cleaned },
    };
    const [row] = await this.db
      .update(ewohRetrospective)
      .set({ lessonsJson: cleaned, assembledJson: nextAssembled })
      .where(
        and(
          eq(ewohRetrospective.orgId, ctx.primaryOrgId),
          eq(ewohRetrospective.retrospectiveId, retrospectiveId),
        ),
      )
      .returning();
    if (!row) throw new NotFoundException(`复盘 ${retrospectiveId} 不存在（同租户内）`);
    await this.auditService.appendAuditLog({
      actorId: ctx.userId,
      orgId: ctx.primaryOrgId,
      action: 'retrospective.update_lessons',
      entityType: 'retrospective',
      entityId: retrospectiveId,
      reason: `${cleaned.length} lessons`,
    });
    return this.toRecord(row);
  }

  // ── 组装（纯逻辑，可测）────────────────────────────────────────────────

  private buildAssembled(input: {
    plan: typeof ewohSchedulePlan.$inferSelect;
    assignments: Array<typeof ewohSchedulingPlanAssignment.$inferSelect>;
    triggerEvent: typeof ewohEvent.$inferSelect | null;
    dqConfirmation: typeof ewohDataQualityConfirmationTable.$inferSelect | null;
    alternatives: Array<{ planId: string; planName: string | null; status: string | null }>;
    executions: Array<typeof ewohSchedulingExecution.$inferSelect>;
    feedback: Array<typeof ewohSchedulingFeedback.$inferSelect>;
    annotations: Array<typeof ewohOutcomeAnnotation.$inferSelect>;
  }): AssembledRetrospective {
    const gaps: string[] = [];
    const { plan, assignments, triggerEvent, dqConfirmation, alternatives, executions, feedback, annotations } = input;

    // 第①段 感知。
    if (!triggerEvent) gaps.push('trigger_event_not_linked: 未找到引用触发实体的目录事件，感知起点不可考');
    const affectedTaskIds = [...new Set(assignments.map((a) => a.taskId).filter((t): t is string => !!t))];
    const affectedPersonIds = [...new Set(assignments.map((a) => a.personId).filter((p): p is string => !!p))];
    const affectedDeviceIds = [...new Set(assignments.map((a) => a.deviceId).filter((d): d is string => !!d))];
    const affectedStationIds = [...new Set(assignments.map((a) => a.stationId).filter((s): s is string => !!s))];

    // 第②段 数据质量。
    if (triggerEvent && !dqConfirmation) {
      gaps.push('data_quality_unconfirmed: 触发事件数据质量尚无人工确认（自动分级仅供参考）');
    }

    // 第③段 决策。
    const constraintsConsidered = (plan.constraintsJson as Array<Record<string, unknown>> | null ?? [])
      .map((c) => String(c.type ?? c.constraintType ?? 'unknown'));
    const violations = (plan.violationsJson as Array<Record<string, unknown>> | null ?? []);
    const confidenceLevel: 'high' | 'medium' | 'low' | 'unknown' =
      plan.solverStatus === 'OPTIMAL' || plan.solverStatus === 'FEASIBLE'
        ? 'medium'
        : plan.solverStatus === 'HEURISTIC'
          ? 'medium'
          : plan.solverStatus === 'FALLBACK' || plan.solverStatus === 'TIMEOUT' || plan.solverStatus === 'UNAVAILABLE'
            ? 'low'
            : 'unknown';
    if (!alternatives.length) gaps.push('no_alternative_plans: 未聚合到同触发候选方案，方案对比段缺失');

    // 第④段 授权。
    const mode: 'human_approval' | 'auto_policy' | 'unknown' =
      plan.confirmedBy ? 'human_approval' : plan.status === 'dispatched' || plan.status === 'completed' || plan.status === 'executing'
        ? 'auto_policy'
        : 'unknown';
    if (mode === 'unknown') gaps.push('authorization_unknown: 无审批人事实且方案未派工，授权模式不可判定');

    // 第⑤段 执行。
    const receipt = { completed: 0, failed: 0, inProgress: 0, cancelled: 0, unknown: 0 };
    for (const e of executions) {
      const s = (e.status ?? '').toUpperCase();
      if (s === 'COMPLETED') receipt.completed += 1;
      else if (s === 'FAILED') receipt.failed += 1;
      else if (s === 'IN_PROGRESS' || s === 'EXECUTING' || s === 'STARTED') receipt.inProgress += 1;
      else if (s === 'CANCELLED') receipt.cancelled += 1;
      else receipt.unknown += 1;
    }
    if (executions.length === 0) gaps.push('no_execution_records: 无执行回执，预计 vs 实际比较段缺失');
    const deviations = executions
      .filter((e) => e.deviationType)
      .map((e) => ({
        assignmentId: e.assignmentId,
        taskId: e.taskId,
        kind: e.deviationType ?? 'unknown',
        planned: e.plannedEndAt ? e.plannedEndAt.toISOString() : null,
        actual: e.actualEndAt ? e.actualEndAt.toISOString() : null,
        detail: e.deviationReason,
      }));

    // 第⑥段 反馈。
    let onTime = 0;
    let measured = 0;
    const latenessTotalMs: number[] = [];
    for (const f of feedback) {
      if (!f.plannedEnd || !f.actualEnd) continue;
      measured += 1;
      const ms = f.actualEnd.getTime() - f.plannedEnd.getTime();
      latenessTotalMs.push(ms);
      if (ms <= 0) onTime += 1;
    }
    const plannedVsActualSummary = measured > 0
      ? `${measured}/${feedback.length} 条反馈有计划-实际对；准时 ${onTime}/${measured}；平均偏差 ${
          Math.round(latenessTotalMs.reduce((a, b) => a + b, 0) / measured / 60000)
        } 分钟`
      : '无可比较的计划-实际对（执行结果尚未回传或反馈未回填）';
    if (measured === 0 && feedback.length === 0) gaps.push('no_feedback_rows: 无调度反馈行，学习输入缺失');

    return {
      perception: {
        summary: triggerEvent
          ? `触发事件 ${triggerEvent.eventType}（${triggerEvent.title ?? ''}）`
          : `触发类型 ${plan.triggerType ?? 'unknown'}${plan.triggerEntityId ? `，实体 ${plan.triggerEntityId}` : ''}（未回溯到目录事件）`,
        triggerEventId: triggerEvent?.eventId ?? null,
        detectedAt: triggerEvent?.occurredAt ? triggerEvent.occurredAt.toISOString() : null,
        source: triggerEvent?.sourceType ?? null,
        evidenceIds: triggerEvent ? [triggerEvent.eventId] : [],
      },
      dataQuality: {
        level: triggerEvent
          ? String((triggerEvent.evidenceJson as Record<string, unknown> | null)?.dataQuality ?? 'unknown')
          : 'unknown',
        confirmation: dqConfirmation
          ? {
              verdict: dqConfirmation.verdict === 'contested' ? 'contested' : 'confirmed',
              confirmedBy: dqConfirmation.confirmedBy,
              confirmedAt: dqConfirmation.confirmedAt.toISOString(),
              note: dqConfirmation.note,
            }
          : null,
        freshnessNote: plan.snapshotVersion ? `基于世界快照 ${plan.snapshotVersion}` : '无快照版本记录',
        evidenceIds: dqConfirmation ? [triggerEvent?.eventId ?? ''] : [],
      },
      decision: {
        affectedTaskIds,
        affectedPersonIds,
        affectedDeviceIds,
        affectedStationIds,
        chosenPlanId: plan.planId,
        alternativePlanIds: alternatives.map((a) => a.planId),
        objectivesSummary: plan.metricsJson
          ? JSON.stringify(plan.metricsJson).slice(0, 400)
          : '无指标快照',
        constraintsConsidered,
        risks: violations.slice(0, 10).map((v) => JSON.stringify(v).slice(0, 200)),
        confidence: {
          level: confidenceLevel,
          basis: `solverStatus=${plan.solverStatus ?? 'null'}${plan.fallbackReason ? `; fallback=${plan.fallbackReason}` : ''}`,
        },
        evidenceIds: [plan.planId, ...alternatives.map((a) => a.planId)],
      },
      authorization: {
        mode,
        approvedBy: plan.confirmedBy ?? null,
        approvedAt: plan.confirmedAt ? plan.confirmedAt.toISOString() : null,
        policyVersion: plan.policyVersion != null ? String(plan.policyVersion) : null,
        evidenceIds: [plan.planId],
      },
      execution: {
        dispatchedAssignmentCount: assignments.filter((a) => a.status !== 'proposed').length,
        receiptSummary: receipt,
        deviations,
        evidenceIds: executions.map((e) => e.executionId),
      },
      feedback: {
        plannedVsActualSummary,
        kpi: {
          measuredPairs: measured,
          onTimeCount: onTime,
          onTimeRate: measured > 0 ? onTime / measured : null,
          deviations: deviations.length,
          annotations: annotations.length,
        },
        outcomeAnnotationIds: annotations.map((a) => a.annotationId),
        lessons: [],
        evidenceIds: [
          ...feedback.map((f) => f.feedbackId),
          ...annotations.map((a) => a.annotationId),
        ],
      },
      gaps,
    };
  }

  /** 规则层经验条目（AI narrative 之外的结构化经验；人工可修订）。 */
  private deriveLessons(assembled: AssembledRetrospective): RetrospectiveLesson[] {
    const lessons: RetrospectiveLesson[] = [];
    const { execution, feedback, dataQuality } = assembled;
    if (execution.deviations.length > 0) {
      lessons.push({
        title: `执行偏差 ${execution.deviations.length} 起，计划时长/路由需校准`,
        detail: `偏差类型分布：${JSON.stringify(
          execution.deviations.reduce<Record<string, number>>((acc, d) => {
            acc[d.kind] = (acc[d.kind] ?? 0) + 1;
            return acc;
          }, {}),
        )}。建议复盘对应任务的时长模型与路由假设。`,
        severity: execution.deviations.length >= 3 ? 'warning' : 'info',
        evidenceIds: execution.deviations.slice(0, 5).map((d) => d.assignmentId),
      });
    }
    if (feedback.kpi.onTimeRate != null && feedback.kpi.onTimeRate < 0.7) {
      lessons.push({
        title: `准时率仅 ${Math.round((feedback.kpi.onTimeRate ?? 0) * 100)}%，排产裕量不足`,
        detail: '实际完成普遍晚于计划。考虑增大时长估计安全系数或收紧并发资源假设。',
        severity: 'warning',
        evidenceIds: feedback.evidenceIds.slice(0, 5),
      });
    }
    if (!dataQuality.confirmation) {
      lessons.push({
        title: '触发事件数据质量未人工确认',
        detail: '本次决策链起点的数据可信度只有自动分级。下次同类异常应先完成数据质量确认再审批。',
        severity: 'info',
        evidenceIds: [],
      });
    }
    if (lessons.length === 0) {
      lessons.push({
        title: '本次闭环无明显异常',
        detail: '执行与反馈段未发现显著偏差；保留本条作为运行记忆基线。',
        severity: 'info',
        evidenceIds: [],
      });
    }
    return lessons;
  }

  /** LLM 总结 + 规则模板兜底（与 scheduling-narrator 同纪律：事务外调用）。 */
  private async composeNarrative(
    assembled: AssembledRetrospective,
    planName: string,
  ): Promise<{ text: string; source: NarrativeSource | null; model: string | null }> {
    const ruleText = this.ruleNarrative(assembled, planName);
    if (!this.arkService) {
      return { text: ruleText, source: 'rule_fallback', model: null };
    }
    try {
      const configured = await this.arkService.isConfigured();
      if (!configured) {
        return { text: ruleText, source: 'rule_fallback', model: null };
      }
      const result = await this.arkService.ask(
        [
          '你是工厂运行记忆复盘助手。基于给定闭环结构化事实写一段 150 字以内的中文复盘总结，',
          '面向班组长与调度员：发生了什么、做了什么决策、执行结果与预计的差距、最重要的经验。',
          '只使用给定事实，不编造数字；数据缺失时明确说"无数据"。',
        ].join(''),
        JSON.stringify({ planName, assembled }),
        { kind: 'analysis' },
      );
      if (result.ok && result.text?.trim()) {
        return { text: result.text.trim(), source: 'llm', model: result.model };
      }
      this.logger.warn(`复盘 LLM 总结失败，回落规则模板: ${result.error ?? 'empty'}`);
      return { text: ruleText, source: 'rule_fallback', model: null };
    } catch (err) {
      this.logger.warn(`复盘 LLM 调用异常，回落规则模板: ${err instanceof Error ? err.message : String(err)}`);
      return { text: ruleText, source: 'rule_fallback', model: null };
    }
  }

  private ruleNarrative(assembled: AssembledRetrospective, planName: string): string {
    const parts: string[] = [];
    parts.push(assembled.perception.summary);
    parts.push(
      assembled.authorization.mode === 'human_approval'
        ? `经 ${assembled.authorization.approvedBy} 人工审批后执行`
        : assembled.authorization.mode === 'auto_policy'
          ? '按策略自动授权执行'
          : '授权方式未知',
    );
    const r = assembled.execution.receiptSummary;
    parts.push(
      `派工 ${assembled.execution.dispatchedAssignmentCount} 项，回执：完成 ${r.completed}、失败 ${r.failed}、进行中 ${r.inProgress}、取消 ${r.cancelled}、未知 ${r.unknown}`,
    );
    parts.push(assembled.feedback.plannedVsActualSummary);
    if (assembled.gaps.length > 0) {
      parts.push(`数据缺口 ${assembled.gaps.length} 项（详见 gaps 清单）`);
    }
    return `【${planName}】${parts.join('；')}。`;
  }

  // ── 持久化辅助 ─────────────────────────────────────────────────────────

  /**
   * upsert：同 (org, scope, target) 的既有非 superseded 复盘 → superseded 后
   * 插入新行。写路径必须带租户 GUC（RLS retrospective_org_isolation 拒绝裸写）。
   * 注意 _created_by 为 uuid 列：会话 userId 是用户名口径（如 'admin'），
   * 不做强转（强转必炸）；操作者事实由审计日志 actorId 承载。
   */
  private async persistWithSupersede(record: RetrospectiveRecord, ctx: OrgContext): Promise<RetrospectiveRecord> {
    return this.requestDatabaseContext.runInTransaction(
      buildGucSettings(ctx),
      async () => {
        await this.db
          .update(ewohRetrospective)
          .set({ status: 'superseded' })
          .where(
            and(
              eq(ewohRetrospective.orgId, ctx.primaryOrgId),
              eq(ewohRetrospective.scope, record.scope),
              eq(ewohRetrospective.targetId, record.targetId),
              ne(ewohRetrospective.status, 'superseded'),
            ),
          );
        const inserted = await this.db
          .insert(ewohRetrospective)
          .values({
            orgId: ctx.primaryOrgId,
            retrospectiveId: record.retrospectiveId,
            scope: record.scope,
            targetId: record.targetId,
            title: record.title,
            periodStart: record.periodStart ? new Date(record.periodStart) : null,
            periodEnd: record.periodEnd ? new Date(record.periodEnd) : null,
            triggerEventId: record.triggerEventId,
            status: record.status,
            assembledJson: record.assembled as unknown as Record<string, unknown>,
            narrative: record.narrative,
            narrativeSource: record.narrativeSource,
            narrativeModel: record.narrativeModel,
            lessonsJson: record.assembled.feedback.lessons as unknown as Record<string, unknown>[],
            publishedAt: null,
          })
          .returning();
        return this.toRecord(inserted[0]);
      },
    );
  }

  /** 回溯触发事件：方案生成前 24h 内、evidence/title 引用触发实体的最新目录事件。 */
  private async findTriggerEvent(
    plan: typeof ewohSchedulePlan.$inferSelect,
    orgId: string,
  ): Promise<typeof ewohEvent.$inferSelect | null> {
    if (!plan.triggerEntityId || !plan.createdAt) return null;
    const since = new Date(plan.createdAt.getTime() - TRIGGER_LOOKBACK_MS);
    const candidates = await this.db
      .select()
      .from(ewohEvent)
      .where(
        and(
          eq(ewohEvent.orgId, orgId),
          gte(ewohEvent.occurredAt, since),
          lte(ewohEvent.occurredAt, plan.createdAt),
        ),
      )
      .orderBy(desc(ewohEvent.occurredAt))
      .limit(200);
    const entity = plan.triggerEntityId;
    return (
      candidates.find((e) => {
        const ev = e.evidenceJson as Record<string, unknown> | null;
        return (
          e.title?.includes(entity)
          || ev?.entityId === entity
          || ev?.deviceId === entity
          || ev?.personId === entity
          || ev?.sourceEventEntityId === entity
        );
      }) ?? null
    );
  }

  /** 同触发候选方案：同 triggerType+triggerEntityId、±1h 窗口、非本方案。 */
  private async findAlternatives(
    plan: typeof ewohSchedulePlan.$inferSelect,
    orgId: string,
  ): Promise<Array<{ planId: string; planName: string | null; status: string | null }>> {
    if (!plan.triggerType) return [];
    const since = new Date((plan.createdAt?.getTime() ?? Date.now()) - ALTERNATIVE_WINDOW_MS);
    const until = new Date((plan.createdAt?.getTime() ?? Date.now()) + ALTERNATIVE_WINDOW_MS);
    const rows = await this.db
      .select({ planId: ewohSchedulePlan.planId, planName: ewohSchedulePlan.planName, status: ewohSchedulePlan.status })
      .from(ewohSchedulePlan)
      .where(
        and(
          or(isNull(ewohSchedulePlan.orgId), eq(ewohSchedulePlan.orgId, orgId)),
          eq(ewohSchedulePlan.triggerType, plan.triggerType),
          plan.triggerEntityId
            ? eq(ewohSchedulePlan.triggerEntityId, plan.triggerEntityId)
            : sql`true`,
          ne(ewohSchedulePlan.planId, plan.planId),
          gte(ewohSchedulePlan.createdAt, since),
          lte(ewohSchedulePlan.createdAt, until),
        ),
      )
      .limit(10);
    return rows;
  }

  private toRecord(r: typeof ewohRetrospective.$inferSelect): RetrospectiveRecord {
    return {
      retrospectiveId: r.retrospectiveId,
      // scope 的词表是 RETROSPECTIVE_SCOPES（plan|incident|shift）；原先误用
      // RETROSPECTIVE_STATUSES（draft|published|superseded）校验——合法的
      // incident/shift 行会被错误改写成 'plan'（读面篡改台账事实）。
      scope: (RETROSPECTIVE_SCOPES as readonly string[]).includes(r.scope)
        ? (r.scope as RetrospectiveScope)
        : 'plan',
      targetId: r.targetId,
      title: r.title,
      periodStart: r.periodStart ? r.periodStart.toISOString() : null,
      periodEnd: r.periodEnd ? r.periodEnd.toISOString() : null,
      triggerEventId: r.triggerEventId,
      status: (['draft', 'published', 'superseded'] as const).includes(r.status as never)
        ? (r.status as RetrospectiveStatus)
        : 'draft',
      assembled: r.assembledJson as unknown as AssembledRetrospective,
      narrative: r.narrative,
      narrativeSource: (r.narrativeSource === 'llm' || r.narrativeSource === 'rule_fallback'
        ? r.narrativeSource
        : null) as NarrativeSource | null,
      narrativeModel: r.narrativeModel,
      publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
      createdBy: r.createdBy ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }

  /** RetrospectiveRecorded 目录事件（组装/发布两态都留痕）。 */
  private async recordEvent(record: RetrospectiveRecord, orgId: string, phase: 'draft' | 'published') {
    const eventId = `EVT-${Math.floor(Date.now() / 1000)}-${randomUUID().slice(0, 8)}`;
    const now = new Date();
    const nowIso = now.toISOString();
    const envelope = buildEventEnvelope({
      eventId,
      eventType: 'RetrospectiveRecorded',
      occurredAt: nowIso,
      observedAt: nowIso,
      receivedAt: nowIso,
      source: 'cloud:retrospective',
      subject: record.retrospectiveId,
      correlationId: currentTraceId() ?? null,
    });
    const evidence = envelopeForEvidence(envelope);
    await this.db.insert(ewohEvent).values({
      eventId,
      eventType: 'RetrospectiveRecorded',
      eventCode: 'RETROSPECTIVE_RECORDED',
      severity: 'low',
      title: `RetrospectiveRecorded: ${record.scope}/${record.targetId} (${phase})`,
      status: 'closed',
      sourceType: 'retrospective',
      orgId,
      createdAt: now,
      occurredAt: now,
      receivedAt: now,
      schemaVersion: '1.0.0',
      evidenceJson: {
        envelope: evidence.envelope,
        envelopeSemantics: evidence.envelopeSemantics,
        retrospectiveId: record.retrospectiveId,
        scope: record.scope,
        targetId: record.targetId,
        status: record.status,
        narrativeSource: record.narrativeSource,
      } as unknown as Record<string, unknown>,
    });
  }
}
