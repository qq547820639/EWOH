import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq } from 'drizzle-orm';
import { ewohSchedulingRun } from '@server/database/schema';
import type {
  SchedulingRun,
  SchedulingPlanV2,
  WorldStateSnapshot,
} from '@shared/api.interface';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { buildGucSettings } from '../shared/org-context.interceptor';
import type { OrgContext } from '../shared/org-context.interceptor';
import { TriggerService } from './trigger.service';
import { WorldStateSnapshotService } from './world-state.service';
import { SolverService } from './solver.service';
import { PlanService } from './plan.service';
import { SchedulingPolicyService } from './scheduling-policy.service';
import { ImpactAnalyzer } from './impact-analyzer';

/** 影响分析结果：哪些任务需重排、哪些被冻结、原因说明。 */
export interface ImpactAnalysis {
  affectedTaskIds: string[];
  frozenTaskIds: string[];
  reason: string;
}

/**
 * 重排协调器：对一次触发做影响分析，并据此执行一次确定性的局部/全量重排。
 * 独立可运行的基础 partial-replan 能力。
 */
@Injectable()
export class ReplanCoordinatorService {
  private readonly logger = new Logger(ReplanCoordinatorService.name);
  private readonly impactAnalyzer = new ImpactAnalyzer();

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
    private readonly triggerService: TriggerService,
    private readonly worldStateSnapshotService: WorldStateSnapshotService,
    private readonly solverService: SolverService,
    private readonly planService: PlanService,
    private readonly policyService: SchedulingPolicyService,
  ) {}

  /**
   * 影响分析：识别受影响（需重排）与冻结（保持不动）的任务。
   * 委托给 ImpactAnalyzer（统一异常分类），并保持既有返回形状以兼容调用方。
   */
  async impactAnalysis(
    snapshot: WorldStateSnapshot,
    triggerType: string,
    entityId: string | null,
  ): Promise<ImpactAnalysis> {
    const result = this.impactAnalyzer.analyze(snapshot, {
      eventType: triggerType,
      entityId,
    });
    return {
      affectedTaskIds: result.affectedTaskIds,
      frozenTaskIds: result.frozenTaskIds,
      reason: result.reason,
    };
  }

  /**
   * 处理一次重排触发：求值（去重/去抖）→ 构建快照 → 影响分析 → 局部重排 → 持久化 → 更新运行状态。
   * 局部重排：仅把受影响任务 + 冻结任务交给求解器，无关任务不进入子图（不 churn），
   * 并传递 baselineAssignee 作为 churn/stability 罚项基线。
   */
  async handleTrigger(
    triggerType: string,
    entityId: string | null,
    ctx: OrgContext,
  ): Promise<{ run: SchedulingRun | null; plans: SchedulingPlanV2[]; debounced: boolean }> {
    const run = await this.triggerService.evaluate(triggerType, entityId, ctx);
    if (!run) {
      return { run: null, plans: [], debounced: true };
    }

    // 重排必须基于最新世界状态：always 在此刻重新构建快照，
    // 绝不复用旧 plan/snapshot 的 snapshotVersion。新方案绑定 snapshot.snapshotVersion。
    const snapshot = await this.worldStateSnapshotService.buildSnapshot(ctx);
    const impact = this.impactAnalyzer.analyze(snapshot, {
      eventType: triggerType,
      entityId,
    });
    this.logger.debug(impact.reason);

    // 局部重排子图 = 受影响任务 ∪ 冻结任务；无关任务不进入求解输入 → 天然不 churn。
    const affectedSet = new Set(impact.affectedTaskIds);
    const frozenSet = new Set(impact.frozenTaskIds);
    const partialSnapshot: WorldStateSnapshot = {
      ...snapshot,
      tasks: snapshot.tasks.filter(
        (t) => affectedSet.has(t.id) || frozenSet.has(t.id),
      ),
    };

    // baselineAssignee：当前分配作为 churn/stability 罚项基线，避免已排任务被无谓移动。
    const baselineAssignee = new Map<string, string | null>();
    for (const t of snapshot.tasks) {
      if (t.assigneeId) {
        if (baselineAssignee.has(t.id)) continue;
        baselineAssignee.set(t.id, t.assigneeId);
      }
    }
    for (const la of snapshot.lockedAssignments) {
      baselineAssignee.set(la.taskId, la.personId);
    }

    // 执行中/已锁定分配由 snapshot.lockedAssignments 承载，
    // 求解器据此将 executing/dispatched/in_progress 任务冻结为不可移动项。
    const plans = await this.solverService.solveVariants(partialSnapshot, [], {
      planId: run.runId,
      triggerType,
      triggerEntityId: run.triggerEntityId,
      snapshotVersion: snapshot.snapshotVersion,
      horizonMinutes: 480,
      baselineAssignee,
    });

    for (const plan of plans) {
      await this.planService.persistPlan(plan, ctx);
    }

    await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(ctx),
      async () => {
        await this.db
          .update(ewohSchedulingRun)
          .set({
            status: 'succeeded',
            snapshotVersion: snapshot.snapshotVersion,
            planIds: plans.map((p) => p.planId),
          })
          .where(eq(ewohSchedulingRun.runId, run.runId));
      },
    );

    return { run, plans, debounced: false };
  }
}