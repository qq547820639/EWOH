import { Injectable, Logger, ConflictException, NotFoundException } from '@nestjs/common';
import type {
  OverridePreviewResponse,
  PlanOverrideAction,
  PlanOverrideRequest,
  SchedulingConstraint,
  SchedulingPlanV2,
  WorldStateSnapshot,
} from '@shared/api.interface';
import type { OrgContext } from '../shared/org-context.interceptor';
import { PlanService } from './plan.service';
import { SolverService } from './solver.service';
import { WorldStateSnapshotService } from './world-state.service';
import { ConstraintLoaderService } from './constraint-loader.service';
import { PlanCompareService } from './plan-compare.service';

/** 覆盖动作 → SchedulingConstraint 类型映射（与 SchedulerService.applyOverrides 同源）。 */
const OVERRIDE_KIND_TO_TYPE: Record<string, string> = {
  LOCK_PERSON: 'LOCKED_PERSON',
  LOCK_DEVICE: 'LOCKED_DEVICE',
  LOCK_STATION: 'LOCKED_STATION',
  LOCK_TIME: 'LOCKED_TIME',
  LOCK_ASSIGNMENT: 'LOCKED_ASSIGNMENT',
  EXCLUDE_RESOURCE: 'EXCLUDED_RESOURCE',
  PREFER_RESOURCE: 'PREFERRED_RESOURCE',
  BOOST: 'MANUAL_BOOST',
  ADJUST_TIME: 'LOCKED_TIME',
  CHANGE_RESOURCE: 'LOCKED_ASSIGNMENT',
};

/**
 * Override Preview（Phase 1 / P1-8，05 §3.13）：POST /plans/:planId/overrides/preview。
 *
 * 纯计算、不落库、不触发正式重排：同一快照 + 请求约束求解候选方案（PREVIEW-*），
 * 与 baseline 对比产出 7 项 delta。safetyCritical 任务不可被预览动作改变（复用守卫）。
 */
@Injectable()
export class OverridePreviewService {
  private readonly logger = new Logger(OverridePreviewService.name);

  constructor(
    private readonly planService: PlanService,
    private readonly solverService: SolverService,
    private readonly worldStateSnapshotService: WorldStateSnapshotService,
    private readonly constraintLoaderService: ConstraintLoaderService,
    private readonly planCompareService: PlanCompareService,
  ) {}

  /** 只读预览：同一快照 + 请求约束求解候选方案，与 baseline 对比产出 7 项 delta。 */
  async preview(
    planId: string,
    body: PlanOverrideRequest,
    ctx: OrgContext,
  ): Promise<OverridePreviewResponse> {
    // ADR-071：预览读面透传 ctx（跨租户方案与不存在同语义 → 404）。
    const baseline = await this.planService.getPlan(planId, ctx).catch(() => null);
    if (!baseline) throw new NotFoundException(`Plan ${planId} not found`);

    // 预览不落库：使用只读快照，避免每次预览都写入全量 snapshotJson
    // 并竞争同一天的版本计数器行锁（buildSnapshot 语义供写路径使用）。
    const snapshot = await this.worldStateSnapshotService.buildSnapshotReadOnly(ctx);

    // safetyCritical 守卫：预览动作不得改变安全关键任务的分配/时间（SAFETY_CRITICAL_LOCKED 语义）。
    await this.assertNoSafetyCriticalChange(baseline, body.actions, snapshot);

    const operator = body.operator || ctx.userId;
    const constraints = this.actionsToConstraints(body.actions, {
      operator,
      reason: body.reason,
      snapshotVersion: baseline.snapshotVersion,
    });
    // 合并方案继承的持久化人工约束（P0-2：预览同样继承 LOCK/EXCLUDE）。
    const effective = await this.constraintLoaderService.loadForPlan(planId, constraints, ctx);

    const candidatePlanId = `PREVIEW-${Date.now()}`;
    let candidate: SchedulingPlanV2 | null = null;
    let previewError: string | null = null;
    try {
      const solved = await this.solverService.solve(snapshot, effective, {
        planId: candidatePlanId,
        planName: 'override-preview',
        triggerType: 'MANUAL',
        triggerEntityId: planId,
        snapshotVersion: snapshot.snapshotVersion,
        horizonMinutes: baseline.horizonMinutes ?? 480,
      });
      candidate = solved;
      // PREVIEW-*：不持久化（候选方案仅内存返回）。
    } catch (err) {
      previewError = (err as Error)?.message ?? String(err);
      this.logger.warn(`override preview failed for ${planId}: ${previewError}`);
    }

    if (!candidate) {
      return {
        planId,
        readonly: true,
        affectedAssignments: body.actions.map((a) => a.taskId).filter(Boolean),
        conflictsIntroduced: [
          {
            conflictId: `PREVIEW-FAILED-${Date.now()}`,
            type: 'preview_failed',
            message: previewError ?? '预览求解失败',
          },
        ],
        latenessDeltaMinutes: 0,
        travelDeltaMinutes: 0,
        workloadDelta: 0,
        stationWaitDeltaMinutes: 0,
        planChurn: 0,
        candidatePlanId,
      };
    }

    const diff = this.planCompareService.compare(baseline, candidate);
    const affectedAssignments = Array.from(
      new Set([
        ...body.actions.map((a) => a.taskId).filter(Boolean),
        ...diff.diffByTask.map((d) => d.taskId),
      ]),
    );

    return {
      planId,
      readonly: true,
      affectedAssignments,
      conflictsIntroduced: [],
      latenessDeltaMinutes: this.round1(
        (candidate.metrics.lateMinutes ?? 0) - (baseline.metrics.lateMinutes ?? 0),
      ),
      travelDeltaMinutes: this.round1(
        ((candidate.metrics.walkingMeters ?? 0) - (baseline.metrics.walkingMeters ?? 0)) / 60,
      ),
      workloadDelta: this.round2(
        (candidate.metrics.maxWorkload ?? 0) - (baseline.metrics.maxWorkload ?? 0),
      ),
      stationWaitDeltaMinutes: this.round1(
        (candidate.metrics.stationWaitMinutes ?? 0) -
          (baseline.metrics.stationWaitMinutes ?? 0),
      ),
      planChurn: diff.churn,
      candidatePlanId: candidate.planId,
    };
  }

  /** 覆盖动作 → SchedulingConstraint（与 SchedulerService.actionsToConstraints 同构）。 */
  private actionsToConstraints(
    actions: PlanOverrideAction[],
    meta: { operator: string; reason?: string; snapshotVersion: string },
  ): SchedulingConstraint[] {
    return actions.map((a, i) => {
      const type =
        OVERRIDE_KIND_TO_TYPE[a.kind] ?? a.kind;
      const personId = a.changeResource?.personId ?? a.personId;
      const deviceId = a.changeResource?.deviceId ?? a.deviceId;
      const stationId = a.changeResource?.stationId ?? a.stationId;
      return {
        id: `PREVIEW-CON-${Date.now()}-${i}`,
        type: type as SchedulingConstraint['type'],
        taskId: a.taskId,
        personId,
        deviceId,
        stationId,
        zoneId: a.zoneId,
        startMs: a.startMs,
        endMs: a.endMs,
        operator: meta.operator,
        reason: a.reason ?? meta.reason,
        validFrom: a.validFrom,
        expiresAt: a.expiresAt,
        snapshotVersion: meta.snapshotVersion,
        validFromMs: a.validFrom ?? null,
        expiresAtMs: a.expiresAt ?? null,
      };
    });
  }

  /** safetyCritical 守卫：预览动作不得改变安全关键任务的分配/时间。 */
  private async assertNoSafetyCriticalChange(
    baseline: SchedulingPlanV2,
    actions: PlanOverrideAction[],
    snapshot: WorldStateSnapshot,
  ): Promise<void> {
    const safetyCriticalTaskIds = new Set(
      (snapshot.tasks ?? [])
        .filter((t) => t.safetyCritical === true)
        .map((t) => t.id),
    );
    if (safetyCriticalTaskIds.size === 0) return;
    const currentByTask = new Map(baseline.assignments.map((a) => [a.taskId, a]));
    const nowMs = (t?: string | null): number | null => {
      const ms = t ? Date.parse(t) : NaN;
      return Number.isFinite(ms) ? ms : null;
    };
    for (const a of actions) {
      if (!a.taskId || !safetyCriticalTaskIds.has(a.taskId)) continue;
      const cur = currentByTask.get(a.taskId);
      if (!cur) continue;
      const personId = a.changeResource?.personId ?? a.personId;
      const deviceId = a.changeResource?.deviceId ?? a.deviceId;
      const stationId = a.changeResource?.stationId ?? a.stationId;
      const changed =
        (personId != null && personId !== cur.personId) ||
        (deviceId != null && deviceId !== cur.deviceId) ||
        (stationId != null && stationId !== cur.stationId) ||
        (a.startMs != null && a.startMs !== nowMs(cur.plannedStart)) ||
        (a.endMs != null && a.endMs !== nowMs(cur.plannedEnd));
      if (changed) {
        throw new ConflictException(
          `SAFETY_CRITICAL_LOCKED: task ${a.taskId} 为安全关键任务，禁止通过 override 预览改变其分配/时间`,
        );
      }
    }
  }

  private round1(v: number): number {
    return Math.round(v * 10) / 10;
  }

  private round2(v: number): number {
    return Math.round(v * 100) / 100;
  }
}
