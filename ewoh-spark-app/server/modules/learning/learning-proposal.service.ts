import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { ewohLearningProposal, ewohEvent, ewohTelemetry, ewohLearningEvaluation } from '@server/database/schema';
import {
  validateLearningProposal,
  proposalTransitionAllowed,
  evaluateRuleThresholdShadow,
  type ShadowEval,
  type ThresholdChange,
} from '@shared/learning-proposal';
import { buildEventEnvelope, envelopeForEvidence } from '@shared/event-envelope';
import { currentTraceId } from '@server/common/request-context';
import { projectLearningProposalActivationDecision } from '../scheduler/decision-projection';
import type { DecisionRecord } from '@shared/decision';

/** db 或事务句柄（NEST-344：recordEvent 在转移事务内执行）。 */
type ProposalDb = Pick<PostgresJsDatabase, 'insert'>;

export interface ProposeLearningInput {
  proposalId?: string;
  kind: string;
  change: ThresholdChange;
  facts?: Array<Record<string, unknown>>;
  evaluationRef?: { evalId: string };
}

export interface ActiveThresholds {
  workload?: number;
  fatigue?: number;
  ergonomicRisk?: number;
}

/**
 * R2-SBZ-004：影子评估事实窗口的数据来源标注（证据链可审计）。
 * 无法从库内事实源重建的字段（如 ergonomicRisk）显式标注缺省口径，
 * 绝不静默编造。
 */
export interface ShadowFactsProvenance {
  source: string;
  window: { from: string; to: string };
  factsCount: number;
  fields: Record<string, string>;
}

/** R2-SBZ-004：默认回看窗口（无 evaluationRef 时）＝最近 7 天遥测。 */
const SHADOW_WINDOW_DEFAULT_MS = 7 * 24 * 60 * 60 * 1000;
/** R2-SBZ-004：窗口内事实行上限（与台账 list 上限一致的 bounded 读取）。 */
const SHADOW_FACTS_LIMIT = 500;
/**
 * R2-SBZ-004：ewoh_telemetry 无 ergonomic_risk 列——评估触发条件
 * “workload ≥ t 且 (fatigue ≥ 0.7 或 ergonomicRisk ≥ 0.7)”中该维度
 * 以保守缺省 0 代入（只可能低估触发、绝不高估，失败方向保守），
 * 并在 provenance.fields 中显式标注，不冒充观测事实。
 */
const ERGONOMIC_RISK_UNAVAILABLE_DEFAULT = 0;

/**
 * LearningProposalService（ADR-026 / NO-12b，§10 Level 7 + §12 反馈腿）。
 *
 * - 策略(规则阈值)更新提案台账：propose（契约 fail-closed；带 facts 即
 *   确定性影子评估落 shadow_evaluated，缺 facts 落 proposed）→ shadow
 *   （proposed→shadow_evaluated）→ approve（人审：shadow_evaluated→approved，
 *   approvedBy 必填）→ rollback / reject（理由必填，§33 不静默）；
 * - 影子评估 = 历史事实重放（evaluateRuleThresholdShadow，§18 可解释，
 *   无影子证据的激活被契约 + DB CHECK 双拒绝）；
 * - 激活唯一入口 = getActiveThresholds（本租户 approved 且未回滚的最新提案
 *   → ReasoningService 评估时应用阈值覆盖）——**绝不隐式自动执行**（§2）；
 * - LearningProposalCreated/Resolved 目录事件（61 类）；租户边界 orgId +
 *   DB 层 RLS（standalone_045）双保险。
 */
@Injectable()
export class LearningProposalService {
  private readonly logger = new Logger(LearningProposalService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async propose(input: ProposeLearningInput, orgId: string) {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：学习提案必须带租户上下文');
    }
    const proposalId = input.proposalId?.trim() || `lp:${randomUUID().slice(0, 12)}`;
    // R2-SBZ-004：影子评估证据一律由服务端从库内事实源重建（org 作用域
    // 遥测窗口），客户端 facts 不作证据（防提议者自造低风险 facts 洗白
    // 激活证据链，ADR-026 §18 影子评估=历史事实重放的事实来源前提）。
    const { facts: serverFacts, provenance } = await this.buildShadowFacts(
      orgId,
      input.evaluationRef,
    );
    const hasFacts = serverFacts.length > 0;
    const status = hasFacts ? 'shadow_evaluated' : 'proposed';
    const record: Record<string, unknown> = {
      proposalId,
      kind: String(input.kind ?? ''),
      status,
      change: input.change,
      evaluationRef: input.evaluationRef,
      auditTrail: true,
    };
    if (hasFacts) {
      record.shadowEval = this.runShadow(input.change, serverFacts);
      record.shadowFactsProvenance = provenance;
    }
    // R2-SBZ-004：客户端 facts 仅作对账提示留痕（不作证据、不参与评估）。
    if (Array.isArray(input.facts)) {
      record.clientFactsReconciliation = {
        accepted: false,
        note: '客户端 facts 仅作对账提示，不作影子评估证据（R2-SBZ-004；证据=服务端库内窗口重放）',
        clientFactsCount: input.facts.length,
        serverFactsCount: serverFacts.length,
      };
    }
    const errors = validateLearningProposal(record);
    if (errors.length > 0) {
      throw new BadRequestException(`学习提案违反契约: ${errors.join(', ')}`);
    }
    const existing = await this.db
      .select()
      .from(ewohLearningProposal)
      .where(and(eq(ewohLearningProposal.orgId, orgId), eq(ewohLearningProposal.proposalId, proposalId)))
      .limit(1);
    if (existing.length > 0) {
      this.logger.debug(`学习提案幂等命中: ${proposalId}`);
      return { proposal: this.toProposal(existing[0]), created: false };
    }
    const change = input.change;
    const row = {
      orgId,
      proposalId,
      kind: String(input.kind),
      status: status as 'proposed' | 'shadow_evaluated',
      ruleId: change.ruleId,
      parameter: change.parameter,
      baselineValue: change.baselineValue,
      candidateValue: change.candidateValue,
      shadowEvalJson: (record.shadowEval as ShadowEval | undefined) ?? null,
      approvedBy: null,
      approvedAt: null,
      rejectedBy: null,
      rejectedReason: null,
      rolledBackBy: null,
      rolledBackReason: null,
      evaluationRefJson: (input.evaluationRef ?? null) as { evalId: string } | null,
      recordJson: record,
    };
    const inserted = (await this.db.insert(ewohLearningProposal).values(row).returning())[0];
    await this.recordEvent(this.db, inserted, orgId, 'LearningProposalCreated', status);
    return { proposal: this.toProposal(inserted), created: true };
  }

  /**
   * proposed→shadow_evaluated：补做影子评估。
   * R2-SBZ-004：证据由服务端从库内事实源（org 作用域遥测窗口）重建；
   * clientFacts（若提供）仅作对账提示留痕，绝不参与评估。
   */
  async shadow(
    orgId: string,
    proposalId: string,
    clientFacts?: Array<Record<string, unknown>>,
  ) {
    const current = await this.mustGet(orgId, proposalId);
    this.requireTransition(current.status, 'shadow_evaluated');
    // R2-SBZ-004：服务端重建事实窗口（evaluationRef 强制绑定校验在其中执行）。
    const { facts: serverFacts, provenance } = await this.buildShadowFacts(
      orgId,
      (current.evaluationRefJson as { evalId: string } | null) ?? undefined,
    );
    if (serverFacts.length === 0) {
      throw new BadRequestException(
        'shadow_facts_window_empty：库内无可重建的事实窗口（R2-SBZ-004 fail-closed，不接受客户端供给的影子证据）',
      );
    }
    const shadowEval = this.runShadow(
      {
        ruleId: current.ruleId,
        parameter: current.parameter,
        baselineValue: current.baselineValue,
        candidateValue: current.candidateValue,
      },
      serverFacts,
    );
    const recordJson: Record<string, unknown> = {
      ...(current.recordJson as Record<string, unknown>),
      status: 'shadow_evaluated',
      shadowEval,
      shadowFactsProvenance: provenance,
    };
    // R2-SBZ-004：客户端 facts 仅作对账提示（不作证据）。
    if (Array.isArray(clientFacts)) {
      recordJson.clientFactsReconciliation = {
        accepted: false,
        note: '客户端 facts 仅作对账提示，不作影子评估证据（R2-SBZ-004；证据=服务端库内窗口重放）',
        clientFactsCount: clientFacts.length,
        serverFactsCount: serverFacts.length,
      };
    }
    // NEST-342：状态更新加 eq(status) CAS（两并发 shadow 不再重复覆写）。
    const updated = (
      await this.db
        .update(ewohLearningProposal)
        .set({
          status: 'shadow_evaluated',
          shadowEvalJson: shadowEval,
          recordJson,
          updatedAt: new Date(),
        })
        .where(and(
          eq(ewohLearningProposal.orgId, orgId),
          eq(ewohLearningProposal.id, current.id),
          eq(ewohLearningProposal.status, current.status),
        ))
        .returning()
    )[0];
    if (!updated) {
      throw new BadRequestException(`proposal_state_changed_concurrently:${current.status}`);
    }
    return this.toProposal(updated);
  }

  /** 人审批准：shadow_evaluated→approved（§2 激活阶梯唯一入口，绝不自动批准）。 */
  async approve(orgId: string, proposalId: string, approvedBy: string) {
    const current = await this.mustGet(orgId, proposalId);
    this.requireTransition(current.status, 'approved');
    if (!approvedBy?.trim()) {
      throw new BadRequestException('approve 必须带非空 approvedBy（§2 人审阶梯）');
    }
    const now = new Date();
    // NO-13n / ADR-063：激活决策与状态终态同 UPDATE 原子落库（缺口显式不阻断）。
    const decisionJson = this.projectActivationDecision(
      current, 'approved', approvedBy, undefined, orgId, now,
    );
    // NEST-343/344：CAS（eq(status=current)）+ 事件同事务（状态与留痕一致）。
    const updated = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(ewohLearningProposal)
        .set({
          status: 'approved',
          approvedBy: approvedBy.trim(),
          approvedAt: now,
          ...(decisionJson ? { decisionJson } : {}),
          recordJson: {
            ...(current.recordJson as Record<string, unknown>),
            status: 'approved',
            approvedBy: approvedBy.trim(),
            approvedAt: now.toISOString(),
          },
          updatedAt: now,
        })
        .where(and(
          eq(ewohLearningProposal.orgId, orgId),
          eq(ewohLearningProposal.id, current.id),
          eq(ewohLearningProposal.status, current.status),
        ))
        .returning();
      if (rows.length === 0) {
        throw new BadRequestException(`proposal_state_changed_concurrently:${current.status}`);
      }
      await this.recordEvent(tx, rows[0], orgId, 'LearningProposalResolved', 'approved');
      return rows[0];
    });
    return this.toProposal(updated);
  }

  /** 人审拒绝（理由必填，§33 不静默拒绝）。 */
  async reject(orgId: string, proposalId: string, rejectedBy: string, reason: string) {
    const current = await this.mustGet(orgId, proposalId);
    this.requireTransition(current.status, 'rejected');
    if (!rejectedBy?.trim()) throw new BadRequestException('reject 必须带非空 rejectedBy');
    if (!reason?.trim()) throw new BadRequestException('reject 必须带非空 rejectedReason（§33 不静默拒绝）');
    // NO-13n / ADR-063：拒绝决策与状态终态同 UPDATE 原子落库（缺口显式不阻断）。
    const decisionJson = this.projectActivationDecision(
      current, 'rejected', rejectedBy, reason, orgId, new Date(),
    );
    // NEST-343/344：CAS + 事件同事务。
    const updated = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(ewohLearningProposal)
        .set({
          status: 'rejected',
          rejectedBy: rejectedBy.trim(),
          rejectedReason: reason.trim(),
          ...(decisionJson ? { decisionJson } : {}),
          recordJson: {
            ...(current.recordJson as Record<string, unknown>),
            status: 'rejected',
            rejectedBy: rejectedBy.trim(),
            rejectedReason: reason.trim(),
          },
          updatedAt: new Date(),
        })
        .where(and(
          eq(ewohLearningProposal.orgId, orgId),
          eq(ewohLearningProposal.id, current.id),
          eq(ewohLearningProposal.status, current.status),
        ))
        .returning();
      if (rows.length === 0) {
        throw new BadRequestException(`proposal_state_changed_concurrently:${current.status}`);
      }
      await this.recordEvent(tx, rows[0], orgId, 'LearningProposalResolved', 'rejected');
      return rows[0];
    });
    return this.toProposal(updated);
  }

  /** 人审回滚：approved→rolled_back（回滚后引擎不再应用该覆盖）。 */
  async rollback(orgId: string, proposalId: string, rolledBackBy: string, reason: string) {
    const current = await this.mustGet(orgId, proposalId);
    this.requireTransition(current.status, 'rolled_back');
    if (!rolledBackBy?.trim()) throw new BadRequestException('rollback 必须带非空 rolledBackBy');
    if (!reason?.trim()) throw new BadRequestException('rollback 必须带非空 rolledBackReason（§33 不静默回滚）');
    // NO-13n / ADR-063：回滚决策与状态终态同 UPDATE 原子落库（缺口显式不阻断）。
    const decisionJson = this.projectActivationDecision(
      current, 'rolled_back', rolledBackBy, reason, orgId, new Date(),
    );
    // NEST-343/344：CAS + 事件同事务。
    const updated = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(ewohLearningProposal)
        .set({
          status: 'rolled_back',
          rolledBackBy: rolledBackBy.trim(),
          rolledBackReason: reason.trim(),
          ...(decisionJson ? { decisionJson } : {}),
          recordJson: {
            ...(current.recordJson as Record<string, unknown>),
            status: 'rolled_back',
            rolledBackBy: rolledBackBy.trim(),
            rolledBackReason: reason.trim(),
          },
          updatedAt: new Date(),
        })
        .where(and(
          eq(ewohLearningProposal.orgId, orgId),
          eq(ewohLearningProposal.id, current.id),
          eq(ewohLearningProposal.status, current.status),
        ))
        .returning();
      if (rows.length === 0) {
        throw new BadRequestException(`proposal_state_changed_concurrently:${current.status}`);
      }
      await this.recordEvent(tx, rows[0], orgId, 'LearningProposalResolved', 'rolled_back');
      return rows[0];
    });
    return this.toProposal(updated);
  }

  async listProposals(orgId: string, filters?: { kind?: string; status?: string }) {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：学习提案查询必须带租户上下文');
    }
    const conditions = [eq(ewohLearningProposal.orgId, orgId)];
    if (filters?.kind) conditions.push(eq(ewohLearningProposal.kind, filters.kind));
    if (filters?.status) conditions.push(eq(ewohLearningProposal.status, filters.status));
    const rows = await this.db
      .select()
      .from(ewohLearningProposal)
      .where(and(...conditions))
      .orderBy(desc(ewohLearningProposal.createdAt))
      .limit(500);
    return rows.map((r) => this.toProposal(r));
  }

  async getProposal(orgId: string, proposalId: string) {
    return this.toProposal(await this.mustGet(orgId, proposalId));
  }

  /** 激活面：本租户 approved（未回滚）的最新提案的阈值覆盖（ReasoningService 消费）。 */
  async getActiveThresholds(orgId: string): Promise<ActiveThresholds> {
    if (!orgId?.trim()) return {};
    const rows = await this.db
      .select()
      .from(ewohLearningProposal)
      .where(and(
        eq(ewohLearningProposal.orgId, orgId),
        eq(ewohLearningProposal.status, 'approved'),
      ));
    const thresholds: ActiveThresholds = {};
    const byApprovedAtDesc = [...rows].sort((a, b) => {
      const at = a.approvedAt?.getTime() ?? 0;
      const bt = b.approvedAt?.getTime() ?? 0;
      return bt - at;
    });
    for (const row of byApprovedAtDesc) {
      if (row.ruleId !== 'rule:worker-overload' || row.parameter !== 'workloadThreshold') continue;
      if (thresholds.workload !== undefined) continue; // 同参数取最新（approvedAt desc）
      thresholds.workload = row.candidateValue;
    }
    return thresholds;
  }

  private async mustGet(orgId: string, proposalId: string) {
    const rows = await this.db
      .select()
      .from(ewohLearningProposal)
      .where(and(eq(ewohLearningProposal.orgId, orgId), eq(ewohLearningProposal.proposalId, proposalId)))
      .limit(1);
    if (rows.length === 0) {
      throw new BadRequestException('learning_proposal_not_found（不存在或非本租户）');
    }
    return rows[0];
  }

  private requireTransition(from: string, to: string) {
    if (!proposalTransitionAllowed(from, to)) {
      throw new BadRequestException(`非法提案转移：${from} → ${to} 不允许（ADR-026 状态机）`);
    }
  }

  /**
   * NO-13n / ADR-063：激活/拒绝/回滚决策投影（契约门内）。
   * 缺口/契约失败 → log 显式 + 返回 null（decision_json 不写，留 NULL），
   * 绝不阻断提案主流程（§2/§33）。
   */
  private projectActivationDecision(
    current: typeof ewohLearningProposal.$inferSelect,
    outcome: 'approved' | 'rejected' | 'rolled_back',
    by: string,
    reason: string | undefined,
    orgId: string,
    now: Date,
  ): DecisionRecord | null {
    const { record, issues } = projectLearningProposalActivationDecision({
      proposalId: current.proposalId,
      kind: String(current.kind ?? ''),
      outcome,
      by,
      reason,
      orgId,
      now,
    });
    if (!record) {
      this.logger.warn(
        `learning proposal 决策投影缺口 ${current.proposalId}（不阻断提案主流程）：${issues.join(',')}`,
      );
      return null;
    }
    return record;
  }

  /** 确定性影子评估（§18）：评估器抛错 → 提案创建失败（fail-closed，不静默）。 */
  private runShadow(change: ThresholdChange, facts: Array<Record<string, unknown>>): ShadowEval {
    return evaluateRuleThresholdShadow(
      change.ruleId,
      change.baselineValue,
      change.candidateValue,
      facts as never[],
    );
  }

  /**
   * R2-SBZ-004：服务端从库内事实源重建影子评估事实窗口（org 作用域）。
   *
   * - 事实源：ewoh_telemetry（tenant 作用域 + DB RLS 双保险）；
   * - 窗口：evaluationRef.evalId 命中 ewoh_learning_evaluation（org 作用域）
   *   时取其 periodStart/periodEnd（evaluationRef 强制绑定——未命中显式
   *   拒绝，防伪造窗口）；缺省回看最近 7 天；
   * - 字段映射：loadScore→workload、fatigueTrend→fatigue；entityId 缺失
   *   （无法归属 person）或指标为空的行直接跳过（fail-closed，不补造）；
   * - ergonomicRisk 遥测表无此列 → 保守缺省 0（只可能低估触发）并在
   *   provenance.fields 显式标注数据来源，绝不冒充观测事实。
   */
  private async buildShadowFacts(
    orgId: string,
    evaluationRef?: { evalId: string },
  ): Promise<{ facts: Array<Record<string, unknown>>; provenance: ShadowFactsProvenance }> {
    const now = new Date();
    let from: Date = new Date(now.getTime() - SHADOW_WINDOW_DEFAULT_MS);
    let to: Date = now;
    let windowSource = `default:last-${SHADOW_WINDOW_DEFAULT_MS / (24 * 60 * 60 * 1000)}d`;
    if (evaluationRef?.evalId) {
      const evalRows = await this.db
        .select()
        .from(ewohLearningEvaluation)
        .where(
          and(
            eq(ewohLearningEvaluation.orgId, orgId),
            eq(ewohLearningEvaluation.evalId, evaluationRef.evalId),
          ),
        )
        .limit(1);
      if (evalRows.length === 0) {
        throw new BadRequestException(
          `evaluation_ref_not_found：${evaluationRef.evalId} 不在本租户学习评估台账（R2-SBZ-004 fail-closed，不接受未绑定的时间窗）`,
        );
      }
      from = evalRows[0].periodStart;
      to = evalRows[0].periodEnd;
      windowSource = `evaluationRef:${evaluationRef.evalId}`;
    }
    const telemetryRows = await this.db
      .select()
      .from(ewohTelemetry)
      .where(
        and(
          eq(ewohTelemetry.orgId, orgId),
          gte(ewohTelemetry.ts, from),
          lte(ewohTelemetry.ts, to),
        ),
      )
      .orderBy(desc(ewohTelemetry.ts))
      .limit(SHADOW_FACTS_LIMIT);
    const facts: Array<Record<string, unknown>> = [];
    for (const row of telemetryRows) {
      // 无法归属 person 或指标缺失的行跳过（fail-closed：宁缺毋造）。
      if (!row.entityId || row.loadScore == null || row.fatigueTrend == null) {
        continue;
      }
      facts.push({
        subjectId: row.entityId,
        kind: 'person',
        values: {
          workload: row.loadScore,
          fatigue: row.fatigueTrend,
          ergonomicRisk: ERGONOMIC_RISK_UNAVAILABLE_DEFAULT,
        },
      });
    }
    const provenance: ShadowFactsProvenance = {
      source: 'server:ewoh_telemetry',
      window: { from: from.toISOString(), to: to.toISOString(), basis: windowSource } as ShadowFactsProvenance['window'],
      factsCount: facts.length,
      fields: {
        workload: 'server:ewoh_telemetry.load_score',
        fatigue: 'server:ewoh_telemetry.fatigue_trend',
        ergonomicRisk: 'unavailable:ewoh_telemetry 无此列（保守缺省 0，仅可低估触发；R2-SBZ-004 显式标注）',
      },
    };
    return { facts, provenance };
  }

  private toProposal(row: typeof ewohLearningProposal.$inferSelect): Record<string, unknown> {
    const record = row.recordJson as Record<string, unknown>;
    return {
      proposalId: row.proposalId,
      kind: row.kind,
      status: row.status,
      change: {
        ruleId: row.ruleId,
        parameter: row.parameter,
        baselineValue: row.baselineValue,
        candidateValue: row.candidateValue,
      },
      shadowEval: row.shadowEvalJson ?? undefined,
      // R2-SBZ-004：透出影子证据数据来源标注（服务端库内窗口 + 字段级来源）。
      shadowFactsProvenance: record.shadowFactsProvenance ?? undefined,
      clientFactsReconciliation: record.clientFactsReconciliation ?? undefined,
      approvedBy: row.approvedBy ?? undefined,
      approvedAt: row.approvedAt ? row.approvedAt.toISOString() : undefined,
      rejectedBy: row.rejectedBy ?? undefined,
      rejectedReason: row.rejectedReason ?? undefined,
      rolledBackBy: row.rolledBackBy ?? undefined,
      rolledBackReason: row.rolledBackReason ?? undefined,
      evaluationRef: row.evaluationRefJson ?? undefined,
      auditTrail: record.auditTrail ?? true,
    };
  }

  /**
   * 目录事件落库（NEST-344：接受 db 或事务——终态转移与事件同事务提交，
   * 消除「事件失败状态已改」的不一致窗口）。
   */
  private async recordEvent(
    db: ProposalDb,
    row: typeof ewohLearningProposal.$inferSelect,
    orgId: string,
    eventType: 'LearningProposalCreated' | 'LearningProposalResolved',
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
      source: 'cloud:learning',
      subject: row.proposalId,
      correlationId: currentTraceId() ?? null,
    });
    const envelopeRecord = envelopeForEvidence(envelope);
    await db.insert(ewohEvent).values({
      eventId,
      eventType,
      eventCode: eventType === 'LearningProposalCreated' ? 'LEARNING_PROPOSAL_CREATED' : 'LEARNING_PROPOSAL_RESOLVED',
      severity: 'low',
      title: `${eventType}: ${row.kind} ${row.proposalId}`,
      status: 'open',
      sourceType: 'learning',
      orgId,
      createdAt: now,
      evidenceJson: {
        proposalId: row.proposalId,
        kind: row.kind,
        status: terminalStatus,
        change: { ruleId: row.ruleId, parameter: row.parameter, baselineValue: row.baselineValue, candidateValue: row.candidateValue },
        riskLevel: (row.shadowEvalJson as ShadowEval | null)?.riskLevel ?? undefined,
        correlationId: currentTraceId() ?? null,
        envelopeRecord: envelopeRecord.envelope,
        envelopeSemantics: envelopeRecord.envelopeSemantics,
      },
    });
  }
}
