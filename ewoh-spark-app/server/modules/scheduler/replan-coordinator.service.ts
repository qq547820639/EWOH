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

/** 影响分析结果：哪些任务需重排、哪些被冻结、原因说明。 */
export interface ImpactAnalysis {
  affectedTaskIds: string[];
  frozenTaskIds: string[];
  reason: string;
}

const FROZEN_STATUSES = new Set(['executing', 'dispatched', 'in_progress']);
const PENDING_STATUSES = new Set(['draft', 'pending', 'queued']);

/**
 * 重排协调器：对一次触发做影响分析，并据此执行一次确定性的局部/全量重排。
 * 独立可运行的基础 partial-replan 能力。
 */
@Injectable()
export class ReplanCoordinatorService {
  private readonly logger = new Logger(ReplanCoordinatorService.name);

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
   */
  async impactAnalysis(
    snapshot: WorldStateSnapshot,
    triggerType: string,
    entityId: string | null,
  ): Promise<ImpactAnalysis> {
    const lockedTaskIds = new Set(
      snapshot.lockedAssignments.map((a) => a.taskId),
    );

    // 冻结：执行中/已下发/进行中，或已锁定分配的任务。
    const frozenTaskIds = snapshot.tasks
      .filter(
        (t) => FROZEN_STATUSES.has(t.status) || lockedTaskIds.has(t.id),
      )
      .map((t) => t.id);
    const frozenSet = new Set(frozenTaskIds);

    // 待处理且未冻结的任务为基础候选集。
    let candidates = snapshot.tasks.filter(
      (t) => PENDING_STATUSES.has(t.status) && !frozenSet.has(t.id),
    );

    const type = triggerType.toUpperCase();
    if (entityId) {
      if (type === 'DEVICE_OFFLINE' || type === 'DEVICE_LOW_BATTERY') {
        candidates = candidates.filter((t) => t.deviceId === entityId);
      } else if (type === 'PERSON_UNAVAILABLE') {
        candidates = candidates.filter((t) => t.assigneeId === entityId);
      } else if (type === 'SAFETY_EVENT' || type === 'ZONE_RESTRICTED') {
        const forbiddenZones = new Set(
          snapshot.forbiddenZones.map((z) => z.zoneId),
        );
        candidates = candidates.filter(
          (t) => t.zoneId != null && forbiddenZones.has(t.zoneId),
        );
      }
    }
    // entityId 为 null → 保留全部待处理任务（对 DEVICE/PERSON/SAFETY/ZONE 均如此）。

    const affectedIds = new Set<string>(candidates.map((t) => t.id));

    // 下游传递：任何通过 predecessorIds 传递依赖到受影响任务的待处理任务也纳入。
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of snapshot.tasks) {
        if (affectedIds.has(task.id) || frozenSet.has(task.id)) continue;
        const preds = task.predecessorIds ?? [];
        if (preds.some((p) => affectedIds.has(p))) {
          affectedIds.add(task.id);
          changed = true;
        }
      }
    }

    const affectedTaskIds = Array.from(affectedIds);
    const reason = `${type} impact on ${entityId ?? 'ALL'}: ${affectedTaskIds.length} task(s) affected, ${frozenTaskIds.length} frozen`;
    this.logger.debug(reason);
    return { affectedTaskIds, frozenTaskIds, reason };
  }

  /**
   * 处理一次重排触发：求值（去重/去抖）→ 构建快照 → 影响分析 → 求解 → 持久化 → 更新运行状态。
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

    const snapshot = await this.worldStateSnapshotService.buildSnapshot(ctx);
    await this.impactAnalysis(snapshot, triggerType, entityId);

    const plans = await this.solverService.solveVariants(snapshot, [], {
      planId: run.runId,
      triggerType,
      triggerEntityId: run.triggerEntityId,
      snapshotVersion: snapshot.snapshotVersion,
      horizonMinutes: 480,
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