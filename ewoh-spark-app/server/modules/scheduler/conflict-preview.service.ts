import { Injectable, Logger } from '@nestjs/common';
import type {
  ConflictPreviewResult,
  SchedulingPlanV2,
} from '@shared/api.interface';
import { PlanService } from './plan.service';
import { SolverService } from './solver.service';
import { PlanCompareService } from './plan-compare.service';
import { WorldStateSnapshotService } from './world-state.service';
import { ReplanCoordinatorService } from './replan-coordinator.service';

/**
 * Conflict Preview Replan（Phase 4 / P4-PREVIEW）。
 *
 * 流程：Conflict → Root Cause → Affected → Suggested Action → Preview →
 * Candidate Plan → Plan Diff → Human Confirm → Apply（Apply 走正式 replan 链路）。
 *
 * Preview 是 readonly：不改变正式 plan、不 dispatch、不 reservation、不改 task 状态。
 * 仅基于当前世界快照 + 冲突实体影响分析，生成候选方案并对比 baseline。
 */
@Injectable()
export class ConflictPreviewService {
  private readonly logger = new Logger(ConflictPreviewService.name);

  constructor(
    private readonly planService: PlanService,
    private readonly solverService: SolverService,
    private readonly planCompareService: PlanCompareService,
    private readonly worldStateSnapshotService: WorldStateSnapshotService,
    private readonly replanCoordinator: ReplanCoordinatorService,
  ) {}

  /**
   * 生成预览 replan（readonly）。
   * @param conflictId 冲突 id
   * @param conflict 冲突对象（type/scope/resourceId/taskIds）
   * @param baselinePlanId 当前活跃方案（缺省用最近活跃方案）
   * @param action 建议动作（reallocate/release_reservation/reroute）
   */
  async preview(
    conflictId: string,
    conflict: {
      type: string;
      scope: string;
      resourceId: string | null;
      taskIds: string[];
      message?: string;
    },
    baselinePlanId?: string | null,
    action?: string,
  ): Promise<ConflictPreviewResult> {
    // 1) 世界快照 + 影响分析（复用 ReplanCoordinator 的 ImpactAnalyzer 语义）
    const snapshot = await this.worldStateSnapshotService.buildSnapshot(undefined as never);
    const impact = await this.replanCoordinator.impactAnalysis(
      snapshot,
      conflict.type,
      conflict.resourceId,
    );
    const affectedTasks = [...new Set([...impact.affectedTaskIds, ...conflict.taskIds])];

    // 2) baseline：优先指定方案，否则取最近活跃方案
    let baselinePlan: SchedulingPlanV2 | null = null;
    if (baselinePlanId) {
      try {
        baselinePlan = await this.planService.getPlan(baselinePlanId);
      } catch {
        baselinePlan = null;
      }
    }

    // 3) 候选方案（预览求解：同一快照 + 受影响任务约束；不持久化、不 dispatch）
    const candidatePlanId = `PREVIEW-${conflictId}-${Date.now()}`;
    let candidatePlan: SchedulingPlanV2 | null = null;
    let previewError: string | null = null;
    try {
      const plans = await this.solverService.solveVariants(snapshot, [], {
        planId: candidatePlanId,
        planName: `preview-${conflict.type}`,
        triggerType: conflict.type,
        triggerEntityId: conflict.resourceId,
        snapshotVersion: snapshot.snapshotVersion,
        horizonMinutes: 480,
        baselineAssignee: undefined,
      });
      candidatePlan = plans[0] ?? null;
    } catch (err) {
      previewError = (err as Error)?.message ?? String(err);
      this.logger.warn(`preview replan failed: ${previewError}`);
    }

    // 4) diff（baseline vs candidate）
    const diff =
      baselinePlan && candidatePlan
        ? this.planCompareService.compare(baselinePlan, candidatePlan)
        : null;

    // 5) 剩余冲突（预览只影响受限任务；估算剩余冲突——不做全量重算，标注为 preview 性质）
    const remainingConflicts: ConflictPreviewResult['remainingConflicts'] = [
      {
        conflictId,
        type: conflict.type,
        message:
          previewError ??
          conflict.message ??
          'preview 保留该冲突（确认 Apply 后由正式 replan 重新评估）',
      },
    ];

    return {
      conflictId,
      baselinePlanId: baselinePlan?.planId ?? null,
      candidatePlanId: candidatePlan ? candidatePlan.planId : null,
      diff,
      affectedTasks,
      affectedResources: conflict.resourceId ? [conflict.resourceId] : [],
      remainingConflicts,
      expectedKpiImpact: diff
        ? {
            churn: diff.churn,
            changeCount: diff.diffByTask.length,
            added: diff.added.length,
            removed: diff.removed.length,
          }
        : null,
      readonly: true,
    };
  }
}
