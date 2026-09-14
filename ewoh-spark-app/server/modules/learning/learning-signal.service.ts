import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, asc, desc, eq, gte, isNotNull, isNull, like, ne, sql } from 'drizzle-orm';
import {
  ewohEvent,
  ewohLearningSignal,
  ewohNotification,
  ewohSchedulingExecution,
} from '@server/database/schema';
import {
  SIGNAL_MIN_SAMPLE,
  deriveLearningSignals,
  learningSignalId,
  proposalIdForSignal,
  validateLearningSignal,
  type LearningMemoryInput,
  type LearningSignalRecord,
} from '@shared/learning-signal';
import { summarizeNotificationDisposition, type NotificationMetricRow } from '@shared/notification-metrics';
import type { OrgContext } from '../shared/org-context.interceptor';
import { AuditService } from '../shared/audit.service';
import { LearningProposalService } from './learning-proposal.service';

/**
 * 运行记忆 → 学习信号（NO-54a，学习回路接线）。
 *
 * 补的缺口（`docs/architecture/capability-alignment.md` §3 原 #2）：学习提案此前只有
 * "人手工填规则 + 目标值"一条入口，**运行记忆没有接线**——提醒治理指标、数据质量积压、
 * 执行偏差复发这些已经落库的事实，从来不会变成"该不该调策略"的候选。
 *
 * 三条边界（与 `shared/learning-signal.ts` 一致，服务层不得放宽）：
 *   1. **信号 ≠ 提案**：扫描只写 `ewoh_learning_signal`；只有人点"生成提案"才会创建
 *      `ewoh_learning_proposal`，并走既有的影子评估 → 人审激活阶梯（原则 4/6）；
 *   2. **只读业务事实**：扫描不修改任何告警/偏差/提醒行，只写信号与审计；
 *   3. **人的决定不被覆盖**：重复扫描只刷新实测快照（`last_seen_at`/metrics/evidence），
 *      `status` 与 `decided_*` 永远保留第一次的人决定；条件恶化（严重度升级）会生成
 *      **新信号号**（"变严重了"是新事实），不会被旧的"已忽略"吞掉。
 */
export interface LearningSignalScanResult {
  orgId: string;
  windowDays: number;
  generatedAt: string;
  /** 派生出的信号总数（含已存在被刷新的）。 */
  derived: number;
  created: number;
  refreshed: number;
  /** 已由人处理过（promoted/dismissed）而只刷新快照的信号数。 */
  decisionsPreserved: number;
  /** 契约校验不通过、**未落库**的信号（绝不写非法行）。 */
  rejected: Array<{ signalId: string; errors: string[] }>;
  signals: LearningSignalRecord[];
  memory: {
    notificationTruncated: boolean;
    notificationScanned: number;
    openQualityAlerts: number;
    pendingQualityReminders: number;
    deviationObjects: number;
  };
}

export interface PromoteSignalInput {
  /** 目标阈值（人给；平台只给方向与依据，不替现场决定数值）。 */
  candidateValue: number;
  note?: string | null;
}

const DEFAULT_WINDOW_DAYS = 30;
const NOTIFICATION_ROW_LIMIT = 2000;
/** 待处置积压单独读取的上限（按最老优先）：保证"最老积压"不被最近噪声挤出窗口。 */
const NOTIFICATION_PENDING_ROW_LIMIT = 2000;
const DEVIATION_GROUP_LIMIT = 20;

@Injectable()
export class LearningSignalService {
  private readonly logger = new Logger(LearningSignalService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
    private readonly proposalService: LearningProposalService,
  ) {}

  private requireActor(actor?: OrgContext): OrgContext {
    if (!actor?.primaryOrgId?.trim() || !actor.userId?.trim()) {
      throw new BadRequestException('org/用户上下文缺失：学习信号必须带认证租户上下文');
    }
    return actor;
  }

  /** 扫描运行记忆 → 派生信号（幂等；重复扫描只刷新快照与 last_seen_at）。 */
  async scan(
    actor?: OrgContext,
    options: { windowDays?: number; now?: Date } = {},
  ): Promise<LearningSignalScanResult> {
    const ctx = this.requireActor(actor);
    const orgId = ctx.primaryOrgId;
    const now = options.now ?? new Date();
    const requested = Number(options.windowDays);
    const windowDays = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1), 365)
      : DEFAULT_WINDOW_DAYS;
    const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

    const [notification, thresholds, quality, deviations] = await Promise.all([
      this.readNotificationGovernance(orgId, since, now, windowDays),
      this.readThresholdBaselines(orgId),
      this.readQualityBacklog(orgId),
      this.readDeviationRepeats(orgId, since),
    ]);

    const memory: LearningMemoryInput = {
      orgId,
      windowDays,
      detectedAt: now.toISOString(),
      notification,
      thresholds,
      quality,
      deviations,
    };
    const derived = deriveLearningSignals(memory);

    const result: LearningSignalScanResult = {
      orgId,
      windowDays,
      generatedAt: now.toISOString(),
      derived: derived.length,
      created: 0,
      refreshed: 0,
      decisionsPreserved: 0,
      rejected: [],
      signals: [],
      memory: {
        notificationTruncated: notification.truncated,
        notificationScanned: notification.scanned,
        openQualityAlerts: quality.openAlerts,
        pendingQualityReminders: quality.pendingReminders,
        deviationObjects: deviations.length,
      },
    };

    for (const signal of derived) {
      const errors = validateLearningSignal(signal);
      if (errors.length > 0) {
        // 自己派生的信号也必须过契约：不过就如实报告并**不落库**（不写非法行）。
        this.logger.warn(`学习信号 ${signal.signalId} 未通过契约校验，已跳过：${errors.join(', ')}`);
        result.rejected.push({ signalId: signal.signalId, errors });
        continue;
      }
      const outcome = await this.persistSignal(orgId, signal, ctx.userId, now);
      if (outcome === 'created') result.created += 1;
      else if (outcome === 'refreshed') result.refreshed += 1;
      else result.decisionsPreserved += 1;
      result.signals.push({ ...signal, ...(await this.readDecision(orgId, signal.signalId)) });
    }

    await this.auditService.appendAuditLog({
      actorId: ctx.userId,
      orgId,
      action: 'learning.signal_scan',
      entityType: 'learning_signal',
      entityId: orgId,
      reason: `window=${windowDays}d`,
      before: {
        notificationScanned: notification.scanned,
        openQualityAlerts: quality.openAlerts,
        deviationObjects: deviations.length,
      },
      after: {
        derived: result.derived,
        created: result.created,
        refreshed: result.refreshed,
        decisionsPreserved: result.decisionsPreserved,
        rejected: result.rejected.length,
      },
    });
    return result;
  }

  async list(
    actor?: OrgContext,
    filters: { kind?: string; status?: string; limit?: number } = {},
  ): Promise<LearningSignalRecord[]> {
    const ctx = this.requireActor(actor);
    const conditions = [eq(ewohLearningSignal.orgId, ctx.primaryOrgId)];
    if (filters.kind?.trim()) conditions.push(eq(ewohLearningSignal.kind, filters.kind.trim()));
    if (filters.status?.trim()) conditions.push(eq(ewohLearningSignal.status, filters.status.trim()));
    const limit = Number.isFinite(filters.limit)
      ? Math.min(Math.max(Math.trunc(Number(filters.limit)), 1), 200)
      : 50;
    const rows = await this.db
      .select()
      .from(ewohLearningSignal)
      .where(and(...conditions))
      .orderBy(desc(ewohLearningSignal.lastSeenAt))
      .limit(limit);
    return rows.map((row) => this.toRecord(row));
  }

  /**
   * 人点"生成提案"：把可执行信号转成真正的学习提案（进影子评估 → 人审激活阶梯）。
   *
   * 两道防漂移：①信号必须仍是 `open`（已提案/已忽略 → 409）；②重新读取**当前**生效阈值
   * 与信号扫描时的基线比对，不一致 → 409（人必须重新扫描，绝不拿过期基线生成提案）。
   */
  async promote(
    signalId: string,
    input: PromoteSignalInput,
    actor?: OrgContext,
  ): Promise<{ signal: LearningSignalRecord; proposal: unknown; created: boolean; proposalId: string }> {
    const ctx = this.requireActor(actor);
    const orgId = ctx.primaryOrgId;
    const current = await this.mustGet(orgId, signalId);
    if (current.status === 'promoted') {
      throw new ConflictException(
        `信号 ${signalId} 已生成提案 ${current.promotedProposalId ?? ''}（不重复提案）`,
      );
    }
    if (current.status === 'dismissed') {
      throw new ConflictException(`信号 ${signalId} 已被忽略（${current.decidedReason ?? '无理由'}）：如需提案请重新扫描或改判`);
    }
    if (!current.actionable) {
      throw new BadRequestException(
        `信号 ${signalId} 不可生成提案：${current.notActionableReason ?? '未说明理由'}`,
      );
    }
    const candidateValue = Number(input.candidateValue);
    if (!Number.isFinite(candidateValue) || candidateValue < 0 || candidateValue > 1) {
      throw new BadRequestException('candidateValue 必须是 [0,1] 之间的数值（目标阈值由人给出）');
    }
    if (Math.abs(candidateValue - current.actionable.baselineValue) < 1e-9) {
      throw new BadRequestException('candidateValue 与当前生效阈值相同：没有变化就没有提案');
    }
    // 基线漂移检查（原则 7/8）：扫描之后有人改过阈值 → 这条信号的依据已过期。
    const baseline = await this.readThresholdBaselines(orgId);
    const entry = baseline.find(
      (t) => t.ruleId === current.actionable!.ruleId && t.parameter === current.actionable!.parameter,
    );
    if (!entry || entry.effective === null) {
      throw new ConflictException(
        `当前生效阈值未知（${current.actionable.ruleId}/${current.actionable.parameter}）：先确认生效值再提案`,
      );
    }
    if (Math.abs(entry.effective - current.actionable.baselineValue) > 1e-9) {
      throw new ConflictException(
        `信号依据已过期：扫描时基线 ${current.actionable.baselineValue}，当前生效 ${entry.effective}`
        + '（阈值已被改动 → 请重新扫描后再提案）',
      );
    }

    const proposalId = proposalIdForSignal(signalId);
    const { proposal, created } = await this.proposalService.propose(
      {
        proposalId,
        kind: 'rule_threshold',
        change: {
          ruleId: current.actionable.ruleId,
          parameter: current.actionable.parameter,
          baselineValue: entry.effective,
          candidateValue,
        },
      },
      orgId,
      ctx.userId,
    );

    const decidedAt = new Date();
    await this.db
      .update(ewohLearningSignal)
      .set({
        status: 'promoted',
        promotedProposalId: proposalId,
        decidedBy: ctx.userId,
        decidedAt,
        decidedReason:
          (input.note ?? '').trim()
          || `信号 ${signalId}（方向 ${current.actionable.direction}，基线 ${entry.effective}）→ 提案 ${proposalId}`,
        updatedAt: decidedAt,
        updatedBy: ctx.userId,
      })
      .where(and(eq(ewohLearningSignal.orgId, orgId), eq(ewohLearningSignal.signalId, signalId)));

    await this.auditService.appendAuditLog({
      actorId: ctx.userId,
      orgId,
      action: 'learning.signal_promoted',
      entityType: 'learning_signal',
      entityId: signalId,
      reason: (input.note ?? '').trim() || `candidate=${candidateValue}`,
      before: { status: current.status, baselineValue: current.actionable.baselineValue },
      after: { status: 'promoted', proposalId, candidateValue, direction: current.actionable.direction },
    });
    const updated = await this.mustGet(orgId, signalId);
    return { signal: updated, proposal, created, proposalId };
  }

  /** 人点"忽略"：必须给理由（§33 不静默忽略）；已处理的信号不可重复决定。 */
  async dismiss(signalId: string, input: { reason?: string }, actor?: OrgContext): Promise<LearningSignalRecord> {
    const ctx = this.requireActor(actor);
    const orgId = ctx.primaryOrgId;
    const reason = (input.reason ?? '').trim();
    if (!reason) {
      throw new BadRequestException('忽略信号必须给出理由（否则无人知道为什么这条运行记忆被作废）');
    }
    const current = await this.mustGet(orgId, signalId);
    if (current.status !== 'open') {
      throw new ConflictException(`信号 ${signalId} 已是 ${current.status}（不覆盖第一次的人决定）`);
    }
    const decidedAt = new Date();
    await this.db
      .update(ewohLearningSignal)
      .set({
        status: 'dismissed',
        decidedBy: ctx.userId,
        decidedAt,
        decidedReason: reason,
        updatedAt: decidedAt,
        updatedBy: ctx.userId,
      })
      .where(and(eq(ewohLearningSignal.orgId, orgId), eq(ewohLearningSignal.signalId, signalId)));
    await this.auditService.appendAuditLog({
      actorId: ctx.userId,
      orgId,
      action: 'learning.signal_dismissed',
      entityType: 'learning_signal',
      entityId: signalId,
      reason,
      before: { status: current.status },
      after: { status: 'dismissed' },
    });
    return this.mustGet(orgId, signalId);
  }

  /* ── 记忆读取（只读；口径来自共享纯函数）────────────────────────────── */

  /**
   * 提醒治理快照。作用域 = **全租户**（学习要的是组织级事实），与
   * `NotificationService.dispositionMetrics` 的"按收件人作用域"不同——
   * 但**口径完全同源**：同一个共享纯函数 `summarizeNotificationDisposition`。
   */
  private async readNotificationGovernance(
    orgId: string,
    since: Date,
    now: Date,
    windowDays: number,
  ) {
    const columns = {
      notificationId: ewohNotification.notificationId,
      status: ewohNotification.status,
      channel: ewohNotification.channel,
      externalRef: ewohNotification.externalRef,
      resolution: ewohNotification.resolution,
      createdAt: ewohNotification.createdAt,
      readAt: ewohNotification.readAt,
      resolvedAt: ewohNotification.resolvedAt,
    };
    // NO-61b（2026-09-12 实测缺陷）：原来只取"最近 N 条"，于是**最老的待处置积压**
    // 会被近期噪声挤出取数窗口——而"提醒疲劳"信号恰恰要看最老的积压，结果就是
    // 「陈旧积压因取数上限而消失」（原则 7 禁止的静默缺口）。
    // 现在分两条读：① 最近窗口（处置率口径）；② **待处置积压按最老优先**（保证可见），
    // 合并去重后一起算；`truncated` 如实反映任一来源触顶。
    const [recentRows, oldestPendingRows] = await Promise.all([
      this.db
        .select(columns)
        .from(ewohNotification)
        .where(and(eq(ewohNotification.orgId, orgId), gte(ewohNotification.createdAt, since)))
        .orderBy(desc(ewohNotification.createdAt))
        .limit(NOTIFICATION_ROW_LIMIT),
      this.db
        .select(columns)
        .from(ewohNotification)
        .where(and(eq(ewohNotification.orgId, orgId), eq(ewohNotification.status, 'pending')))
        .orderBy(asc(ewohNotification.createdAt))
        .limit(NOTIFICATION_PENDING_ROW_LIMIT),
    ]);
    const merged = new Map<string, (typeof recentRows)[number]>();
    for (const row of oldestPendingRows) merged.set(row.notificationId, row);
    for (const row of recentRows) merged.set(row.notificationId, row);
    const metricRows: NotificationMetricRow[] = [...merged.values()].map((row) => ({
      notificationId: row.notificationId,
      status: row.status,
      channel: row.channel,
      externalRef: row.externalRef,
      resolution: row.resolution,
      createdAt: row.createdAt ? row.createdAt.toISOString() : null,
      readAt: row.readAt ? row.readAt.toISOString() : null,
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    }));
    const summary = summarizeNotificationDisposition(metricRows, { now, windowDays, minSample: SIGNAL_MIN_SAMPLE });
    return {
      ...summary,
      truncated: recentRows.length >= NOTIFICATION_ROW_LIMIT
        || oldestPendingRows.length >= NOTIFICATION_PENDING_ROW_LIMIT,
    };
  }

  /** 阈值基线（复用提案服务的读面：生效值/来源/提案证据一处口径）。 */
  private async readThresholdBaselines(orgId: string) {
    const baseline = await this.proposalService.getThresholdBaseline(orgId);
    return baseline.entries.map((entry) => ({
      ruleId: entry.ruleId,
      parameter: entry.parameter,
      effective: entry.effective,
      source: entry.source,
    }));
  }

  private async readQualityBacklog(orgId: string) {
    const [alertRows] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(ewohEvent)
      .where(and(
        eq(ewohEvent.orgId, orgId),
        eq(ewohEvent.eventType, 'DataQualityAlert'),
        ne(ewohEvent.status, 'closed'),
      ));
    const [reminderRows] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(ewohNotification)
      .where(and(
        eq(ewohNotification.orgId, orgId),
        like(ewohNotification.notificationId, 'NTF-DQ-%'),
        isNull(ewohNotification.resolution),
      ));
    return {
      openAlerts: Number(alertRows?.count ?? 0),
      pendingReminders: Number(reminderRows?.count ?? 0),
    };
  }

  /** 偏差复发聚合（同一对象 + 同一偏差类型在窗口内的次数）。 */
  private async readDeviationRepeats(orgId: string, since: Date) {
    const rows = await this.db
      .select({
        deviceId: ewohSchedulingExecution.deviceId,
        personId: ewohSchedulingExecution.personId,
        deviationType: ewohSchedulingExecution.deviationType,
        count: sql<number>`count(*)::int`,
        lastAt: sql<string | null>`max(${ewohSchedulingExecution.createdAt})::text`,
        planIds: sql<string[]>`coalesce((array_agg(DISTINCT ${ewohSchedulingExecution.planId}))[1:5], '{}')`,
      })
      .from(ewohSchedulingExecution)
      .where(and(
        eq(ewohSchedulingExecution.orgId, orgId),
        gte(ewohSchedulingExecution.createdAt, since),
        isNotNull(ewohSchedulingExecution.deviationType),
        ne(ewohSchedulingExecution.deviationType, ''),
      ))
      .groupBy(ewohSchedulingExecution.deviceId, ewohSchedulingExecution.personId, ewohSchedulingExecution.deviationType)
      .having(sql`count(*) >= 3`)
      .orderBy(sql`count(*) DESC`)
      .limit(DEVIATION_GROUP_LIMIT);
    return rows.map((row) => ({
      objectType: row.deviceId ? 'device' : row.personId ? 'person' : 'unknown',
      objectId: row.deviceId ?? row.personId ?? 'unknown',
      deviationType: String(row.deviationType ?? ''),
      count: Number(row.count ?? 0),
      lastAt: row.lastAt ? new Date(row.lastAt).toISOString() : null,
      samplePlanIds: Array.isArray(row.planIds) ? row.planIds.filter((id): id is string => typeof id === 'string' && id !== '') : [],
    }));
  }

  /* ── 落库 ─────────────────────────────────────────────────────────────── */

  private async persistSignal(
    orgId: string,
    signal: LearningSignalRecord,
    actorId: string,
    now: Date,
  ): Promise<'created' | 'refreshed' | 'preserved'> {
    const [existing] = await this.db
      .select({ id: ewohLearningSignal.id, status: ewohLearningSignal.status })
      .from(ewohLearningSignal)
      .where(and(eq(ewohLearningSignal.orgId, orgId), eq(ewohLearningSignal.signalId, signal.signalId)))
      .limit(1);
    const snapshot = {
      severity: signal.severity,
      sampleSize: signal.sampleSize,
      confidence: signal.confidence,
      direction: signal.actionable?.direction ?? null,
      ruleId: signal.actionable?.ruleId ?? null,
      parameter: signal.actionable?.parameter ?? null,
      baselineValue: signal.actionable?.baselineValue ?? null,
      metricsJson: signal.metrics,
      evidenceJson: signal.evidenceRefs,
      narrativeJson: signal.narrative,
      notActionableReason: signal.notActionableReason,
      lastSeenAt: now,
      updatedAt: now,
      updatedBy: actorId,
      recordJson: signal as unknown as Record<string, unknown>,
    };
    if (!existing) {
      try {
        await this.db.insert(ewohLearningSignal).values({
          orgId,
          signalId: signal.signalId,
          kind: signal.kind,
          status: 'open',
          subjectKey: signal.subjectKey,
          windowDays: signal.windowDays,
          firstSeenAt: now,
          createdBy: actorId,
          ...snapshot,
        });
        return 'created';
      } catch (err) {
        // NEST-332 同族收口（2026-09-14）：select 幂等预检与 insert 之间存在
        // TOCTOU——并发同 (orgId, signalId) 的落败方撞 uq_ewoh_learning_signal
        // 唯一键，此处捕获后走 update 分支刷新（幂等语义，不再裸抛 500）。
        if ((err as { code?: string })?.code !== '23505') throw err;
      }
    }
    // 已有行：只刷新"实测快照"；人已经做过的决定（promoted/dismissed）原样保留。
    await this.db
      .update(ewohLearningSignal)
      .set(snapshot)
      .where(and(eq(ewohLearningSignal.orgId, orgId), eq(ewohLearningSignal.signalId, signal.signalId)));
    return existing.status === 'open' ? 'refreshed' : 'preserved';
  }

  private async readDecision(orgId: string, signalId: string) {
    const [row] = await this.db
      .select({
        status: ewohLearningSignal.status,
        decidedBy: ewohLearningSignal.decidedBy,
        decidedAt: ewohLearningSignal.decidedAt,
        decidedReason: ewohLearningSignal.decidedReason,
        promotedProposalId: ewohLearningSignal.promotedProposalId,
      })
      .from(ewohLearningSignal)
      .where(and(eq(ewohLearningSignal.orgId, orgId), eq(ewohLearningSignal.signalId, signalId)))
      .limit(1);
    if (!row) return {};
    return {
      status: row.status as LearningSignalRecord['status'],
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      decidedReason: row.decidedReason,
      promotedProposalId: row.promotedProposalId,
    };
  }

  private async mustGet(orgId: string, signalId: string) {
    const [row] = await this.db
      .select()
      .from(ewohLearningSignal)
      .where(and(eq(ewohLearningSignal.orgId, orgId), eq(ewohLearningSignal.signalId, signalId)))
      .limit(1);
    if (!row) throw new NotFoundException(`学习信号 ${signalId} 不存在（同租户内）`);
    return this.toRecord(row);
  }

  private toRecord(row: typeof ewohLearningSignal.$inferSelect): LearningSignalRecord {
    const stored = (row.recordJson ?? {}) as Partial<LearningSignalRecord>;
    return {
      signalId: row.signalId,
      kind: row.kind as LearningSignalRecord['kind'],
      severity: row.severity as LearningSignalRecord['severity'],
      status: row.status as LearningSignalRecord['status'],
      subjectKey: row.subjectKey,
      windowDays: row.windowDays,
      sampleSize: row.sampleSize,
      confidence: (row.confidence as LearningSignalRecord['confidence']) ?? null,
      metrics: (row.metricsJson ?? {}) as Record<string, unknown>,
      narrative:
        (row.narrativeJson as LearningSignalRecord['narrative']) ?? {
          hypothesis: '',
          expectedEffect: '',
          risk: '',
          missing: [],
        },
      evidenceRefs: (row.evidenceJson ?? []) as LearningSignalRecord['evidenceRefs'],
      actionable:
        row.ruleId && row.parameter && row.baselineValue !== null && row.direction
          ? {
              ruleId: row.ruleId,
              parameter: row.parameter,
              direction: row.direction as 'raise' | 'lower',
              baselineValue: row.baselineValue,
              baselineSource: String(
                (stored.actionable as { baselineSource?: string } | null)?.baselineSource ?? 'unknown',
              ),
            }
          : null,
      notActionableReason: row.notActionableReason,
      detectedAt:
        stored.detectedAt
        ?? (row.lastSeenAt ? row.lastSeenAt.toISOString() : new Date(0).toISOString()),
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      decidedReason: row.decidedReason,
      promotedProposalId: row.promotedProposalId,
    };
  }
}

