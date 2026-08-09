import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import {
  ewohSchedulingFeedback,
  ewohSchedulePlan,
  ewohSchedulingPlanAssignment,
} from '@server/database/schema';
import { and, eq } from 'drizzle-orm';
import type {
  SchedulingFeedback,
  SchedulingFeedbackKpis,
  SchedulingFeedbackResource,
} from '@shared/api.interface';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { buildGucSettings } from '../shared/org-context.interceptor';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * 调度反馈（SchedulingFeedback，Task 7）。
 *
 * 观测型记录 planned-vs-actual 执行数据与调度 KPI，仅供离线评估 / 参数对比 /
 * 回归使用。本服务 **绝不** 修改任何生产调度规则或行为：
 *  - 仅写入 / 读取 ewoh_scheduling_feedback 表；
 *  - 所有 record* 方法在调用方都以 try/catch + 可选依赖方式接入，失败不影响调度。
 *
 * 生命周期埋点（由调用方在既有钩子处触发）：
 *  - recordBaseline   —— dispatch 时记录 planned 基线（每 assignment 一行）；
 *  - recordAcceptance —— plan 审批 / 驳回时标记 accepted；
 *  - recordActuals    —— 任务实际开始 / 完成时回填 actual 数据。
 */
@Injectable()
export class SchedulingFeedbackService {
  private readonly logger = new Logger(SchedulingFeedbackService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
  ) {}

  /**
   * 在 dispatch 时记录 planned 基线（观测型，不改变任何调度行为）。
   * 每个 assignment 写入一行；无 assignment 时写一行 plan 级反馈。
   * @returns 写入/更新的反馈行数。
   */
  async recordBaseline(
    planId: string,
    opts?: {
      runId?: string | null;
      solverRuntime?: number | null;
      solverFallback?: boolean;
      replanCount?: number;
      conflictCount?: number;
      overrideCount?: number;
      ts?: Date;
    },
    ctx?: OrgContext,
  ): Promise<number> {
    const [plan] = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(eq(ewohSchedulePlan.planId, planId))
      .limit(1);
    if (!plan) return 0;

    const assignments = await this.db
      .select()
      .from(ewohSchedulingPlanAssignment)
      .where(eq(ewohSchedulingPlanAssignment.planId, planId));

    const metrics = (plan.metricsJson ?? {}) as Record<string, unknown>;
    const solverRuntimeOpt = opts?.solverRuntime ?? (metrics['solveDurationMs'] as number | undefined) ?? null;
    const solverFallbackOpt =
      opts?.solverFallback ?? this.isFallbackStatus(metrics['solverStatus'] as string | undefined);
    const replanCount = opts?.replanCount ?? 0;
    const conflictCount = opts?.conflictCount ?? 0;
    const overrideCount = opts?.overrideCount ?? 0;
    const ts = opts?.ts ?? new Date();
    const runId = opts?.runId ?? plan.triggerEntityId ?? null;
    const orgId = ctx?.primaryOrgId ?? null;
    // 审批发生在 dispatch 之前，故此处按 plan 状态推导验收结果（approved→true, rejected→false）。
    const acceptedFromPlan =
      plan.status === 'approved' ? true : plan.status === 'rejected' ? false : null;

    const gucSettings = buildGucSettings(
      ctx ?? { userId: 'system', primaryOrgId: orgId ?? '' },
    );

    // Phase 4 / P4-T1：plannedWait 语义——同 person 的连续任务，wait = start - 前一任务 end
    // （clamp ≥0）；无前任务（该人员首任务）→ 0（调度起点无等待，非伪造）。按 plannedStart 升序计算。
    const personSeq = new Map<string, { endMs: number }>();
    const sortedAssignments = [...assignments].sort((x, y) => {
      const xs = x.plannedStart ? x.plannedStart.getTime() : 0;
      const ys = y.plannedStart ? y.plannedStart.getTime() : 0;
      return xs - ys;
    });
    const waitByAssignment = new Map<string, number>();
    for (const a of sortedAssignments) {
      if (!a.assignmentId || !a.plannedStart || !a.personId) continue;
      const startMs = a.plannedStart.getTime();
      const prev = personSeq.get(a.personId);
      const waitMs = prev ? Math.max(startMs - prev.endMs, 0) : 0;
      waitByAssignment.set(a.assignmentId, waitMs);
      if (a.plannedEnd) personSeq.set(a.personId, { endMs: a.plannedEnd.getTime() });
    }

    let written = 0;
    await this.requestDatabaseContext.runInTransaction(gucSettings, async () => {
      const targets = assignments.length > 0 ? assignments : [null];
      for (const a of targets) {
        const assignmentId = a?.assignmentId ?? null;
        const taskId = a?.taskId ?? null;
        const originalResource: SchedulingFeedbackResource | null = assignmentId
          ? {
              personId: a.personId ?? null,
              deviceId: a.deviceId ?? null,
              stationId: a.stationId ?? null,
            }
          : null;

        const plannedStart = a?.plannedStart ?? null;
        const plannedEnd = a?.plannedEnd ?? null;
        // Phase 4 / P4-T1 语义修复：plannedTravel 记录 ETA 时间语义（etaSeconds），
        // 而非 distanceMeters；plannedWait 按同 person 前一任务 end 计算（不再恒 null）。
        const plannedTravel = a?.etaSeconds ?? null;
        const plannedWait = assignmentId ? waitByAssignment.get(assignmentId) ?? null : null;

        // 幂等：同一 assignment 已存在则回填 planned 基线，否则新增。
        const [existing] = assignmentId
          ? await this.db
              .select()
              .from(ewohSchedulingFeedback)
              .where(
                and(
                  eq(ewohSchedulingFeedback.assignmentId, assignmentId),
                  eq(ewohSchedulingFeedback.planId, planId),
                ),
              )
              .limit(1)
          : [];

        if (existing) {
          await this.db
            .update(ewohSchedulingFeedback)
            .set({
              plannedStart,
              plannedEnd,
              plannedTravel,
              plannedWait,
              originalResourceJson: originalResource as unknown as Record<string, unknown> | null,
              replanCount,
              conflictCount,
              overrideCount,
              solverRuntime: solverRuntimeOpt,
              solverFallback: solverFallbackOpt,
              ts,
            })
            .where(eq(ewohSchedulingFeedback.feedbackId, existing.feedbackId));
        } else {
          await this.db.insert(ewohSchedulingFeedback).values({
            feedbackId: `FB-${Date.now()}-${this.randomSuffix()}`,
            runId,
            planId,
            taskId,
            assignmentId,
            plannedStart,
            plannedEnd,
            plannedTravel,
            plannedWait,
            originalResourceJson: originalResource as unknown as Record<string, unknown> | null,
            replanCount,
            conflictCount,
            overrideCount,
            solverRuntime: solverRuntimeOpt,
            solverFallback: solverFallbackOpt,
            accepted: acceptedFromPlan,
            ts,
            orgId,
          });
        }
        written += 1;
      }
    });

    this.logger.log(
      `scheduling feedback baseline recorded for plan ${planId} (${written} row${written === 1 ? '' : 's'})`,
    );
    return written;
  }

  /** 记录 plan 审批结果（accepted）。观测型，不影响审批流程。 */
  async recordAcceptance(planId: string, accepted: boolean, ctx?: OrgContext): Promise<void> {
    const gucSettings = buildGucSettings(
      ctx ?? { userId: 'system', primaryOrgId: '' },
    );
    await this.requestDatabaseContext.runInTransaction(gucSettings, async () => {
      await this.db
        .update(ewohSchedulingFeedback)
        .set({ accepted })
        .where(eq(ewohSchedulingFeedback.planId, planId));
    });
    this.logger.log(
      `scheduling feedback acceptance=${String(accepted)} recorded for plan ${planId}`,
    );
  }

  /**
   * 回填任务实际执行数据（实际开始/结束、实际 travel/wait、实际资源）。
   * 观测型，不改变任务或调度状态。
   */
  async recordActuals(
    input: {
      planId?: string;
      assignmentId?: string;
      taskId?: string;
      actualStart?: Date | string | null;
      actualEnd?: Date | string | null;
      actualTravel?: number | null;
      actualWait?: number | null;
      actualResource?: SchedulingFeedbackResource | null;
    },
    ctx?: OrgContext,
  ): Promise<void> {
    const gucSettings = buildGucSettings(
      ctx ?? { userId: 'system', primaryOrgId: '' },
    );
    const toDate = (v: Date | string | null | undefined): Date | null =>
      v == null || v === '' ? null : new Date(v);

    await this.requestDatabaseContext.runInTransaction(gucSettings, async () => {
      const conditions: any[] = [];
      if (input.assignmentId) {
        conditions.push(eq(ewohSchedulingFeedback.assignmentId, input.assignmentId));
      }
      if (input.planId) {
        conditions.push(eq(ewohSchedulingFeedback.planId, input.planId));
      }
      if (input.taskId) {
        conditions.push(eq(ewohSchedulingFeedback.taskId, input.taskId));
      }
      if (conditions.length === 0) return;

      const patch: Record<string, unknown> = {
        actualStart: toDate(input.actualStart),
        actualEnd: toDate(input.actualEnd),
      };
      if (input.actualTravel != null) patch.actualTravel = input.actualTravel;
      if (input.actualWait != null) patch.actualWait = input.actualWait;
      if (input.actualResource != null) {
        patch.actualResourceJson = input.actualResource as unknown as Record<string, unknown>;
      }

      await this.db
        .update(ewohSchedulingFeedback)
        .set(patch)
        .where(and(...conditions));
    });
  }

  /** 读取指定 plan 的反馈行（离线评估视图）。 */
  async listForPlan(planId: string): Promise<SchedulingFeedback[]> {
    const rows = await this.db
      .select()
      .from(ewohSchedulingFeedback)
      .where(eq(ewohSchedulingFeedback.planId, planId));
    return rows.map((r) => this.toFeedback(r));
  }

  /** 全部反馈行（离线评估视图）。 */
  async list(): Promise<SchedulingFeedback[]> {
    const rows = await this.db.select().from(ewohSchedulingFeedback);
    return rows.map((r) => this.toFeedback(r));
  }

  /**
   * 由反馈表派生调度 KPI（acceptanceRate / overrideRate / fallbackRate / solverRuntime +
   * Phase 4 / P4-T1 扩展：on-time rate / mean+P95 lateness / total travel / workload imbalance /
   * plan churn / conflict rate / replan success rate）。输入缺省时显式 null 标注缺数据，不伪造。
   */
  async deriveKpis(): Promise<SchedulingFeedbackKpis> {
    const rows = await this.db.select().from(ewohSchedulingFeedback);
    const total = rows.length;
    let accepted = 0;
    let rejected = 0;
    let overrideRows = 0;
    let fallbackRows = 0;
    let runtimeSum = 0;
    let runtimeCount = 0;
    let replanCount = 0;
    let conflictCount = 0;

    for (const r of rows) {
      if (r.accepted === true) accepted += 1;
      else if (r.accepted === false) rejected += 1;
      if ((r.overrideCount ?? 0) > 0) overrideRows += 1;
      if (r.solverFallback) fallbackRows += 1;
      if (r.solverRuntime != null) {
        runtimeSum += r.solverRuntime;
        runtimeCount += 1;
      }
      replanCount += r.replanCount ?? 0;
      conflictCount += r.conflictCount ?? 0;
    }

    const decided = accepted + rejected;

    // ---- Phase 4 / P4-T1：扩展 KPI（缺失数据显式 null） ----
    // on-time / lateness：需 plannedEnd + actualEnd 成对。
    const lateness: number[] = [];
    let onTime = 0;
    for (const r of rows) {
      if (!r.plannedEnd || !r.actualEnd) continue;
      const ms = r.actualEnd.getTime() - r.plannedEnd.getTime();
      lateness.push(ms);
      if (ms <= 0) onTime += 1;
    }
    const onTimeRate =
      lateness.length > 0 ? onTime / lateness.length : null;
    const sortedLateness = [...lateness].sort((a, b) => a - b);
    const meanLatenessMs =
      sortedLateness.length > 0
        ? sortedLateness.reduce((s, v) => s + v, 0) / sortedLateness.length
        : null;
    const p95LatenessMs =
      sortedLateness.length > 0
        ? sortedLateness[Math.min(
            Math.ceil(sortedLateness.length * 0.95) - 1,
            sortedLateness.length - 1,
          )]
        : null;

    // total travel：plannedTravel 为 etaSeconds 语义 → ms。
    const travelSeconds = rows
      .map((r) => r.plannedTravel)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const totalTravelMs =
      travelSeconds.length > 0
        ? travelSeconds.reduce((s, v) => s + v, 0) * 1000
        : null;

    // workload imbalance：同 person 的任务数 max-min（>=2 人数据才有意义）。
    const perPerson = new Map<string, number>();
    for (const r of rows) {
      const pid = (r.originalResourceJson as { personId?: string | null } | null)?.personId;
      if (!pid) continue;
      perPerson.set(pid, (perPerson.get(pid) ?? 0) + 1);
    }
    const personCounts = [...perPerson.values()];
    const workloadImbalance =
      personCounts.length >= 2
        ? Math.max(...personCounts) - Math.min(...personCounts)
        : null;

    // plan churn：Σ replanCount（重排次数代理）。
    const planChurn = replanCount > 0 ? replanCount : null;

    // conflict rate：Σ conflictCount / totalFeedback（每方案平均冲突数）。
    const conflictRate = total > 0 ? conflictCount / total : null;

    // replan success rate：重排过的行中 accepted=true 占比。
    const replanRows = rows.filter((r) => (r.replanCount ?? 0) > 0);
    const replanAccepted = replanRows.filter((r) => r.accepted === true).length;
    const replanSuccessRate =
      replanRows.length > 0 ? replanAccepted / replanRows.length : null;

    return {
      totalFeedback: total,
      accepted,
      rejected,
      pendingAcceptance: total - decided,
      acceptanceRate: decided > 0 ? accepted / decided : 0,
      overrideRate: total > 0 ? overrideRows / total : 0,
      fallbackRate: total > 0 ? fallbackRows / total : 0,
      solverRuntimeMs: runtimeCount > 0 ? runtimeSum / runtimeCount : 0,
      replanCount,
      conflictCount,
      onTimeRate,
      meanLatenessMs,
      p95LatenessMs,
      totalTravelMs,
      workloadImbalance,
      planChurn,
      conflictRate,
      replanSuccessRate,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private isFallbackStatus(status?: string): boolean {
    if (!status) return false;
    return ['UNAVAILABLE', 'FALLBACK', 'TIMEOUT', 'INFEASIBLE'].includes(
      status.toUpperCase(),
    );
  }

  private toFeedback(
    r: typeof ewohSchedulingFeedback.$inferSelect,
  ): SchedulingFeedback {
    return {
      feedbackId: r.feedbackId,
      runId: r.runId ?? null,
      planId: r.planId,
      taskId: r.taskId ?? null,
      assignmentId: r.assignmentId ?? null,
      plannedStart: r.plannedStart ? r.plannedStart.toISOString() : null,
      actualStart: r.actualStart ? r.actualStart.toISOString() : null,
      plannedEnd: r.plannedEnd ? r.plannedEnd.toISOString() : null,
      actualEnd: r.actualEnd ? r.actualEnd.toISOString() : null,
      plannedTravel: r.plannedTravel ?? null,
      actualTravel: r.actualTravel ?? null,
      plannedWait: r.plannedWait ?? null,
      actualWait: r.actualWait ?? null,
      originalResource: (r.originalResourceJson ?? null) as unknown as SchedulingFeedbackResource | null,
      actualResource: (r.actualResourceJson ?? null) as unknown as SchedulingFeedbackResource | null,
      replanCount: r.replanCount ?? 0,
      conflictCount: r.conflictCount ?? 0,
      overrideCount: r.overrideCount ?? 0,
      solverRuntime: r.solverRuntime ?? null,
      solverFallback: r.solverFallback ?? false,
      accepted: r.accepted ?? null,
      ts: r.ts ? r.ts.toISOString() : new Date().toISOString(),
    };
  }

  private randomSuffix(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 4; i++) {
      s += chars[Math.floor(Math.random() * chars.length)];
    }
    return s;
  }
}