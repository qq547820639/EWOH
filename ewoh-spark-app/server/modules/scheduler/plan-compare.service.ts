import { Injectable, Logger } from '@nestjs/common';
import type {
  AssignmentSnapshot,
  PlanAssignmentDiff,
  PlanCompareResult,
  PlanDiffChangeType,
  SchedulingPlanV2,
} from '@shared/api.interface';

/**
 * Plan Compare 权威 Diff（Phase 4 / P4-COMPARE）。
 *
 * 纯函数：BASELINE/CANDIDATE 两方案按 taskId 对齐，输出 changeTypes（ADDED/REMOVED/
 * PERSON_CHANGED/DEVICE_CHANGED/STATION_CHANGED/TIME_CHANGED/ROUTE_CHANGED/ETA_CHANGED/
 * DISTANCE_CHANGED/WORKLOAD_CHANGED/LATENESS_CHANGED/RISK_CHANGED/CONFLICT_CHANGED/CHURN）、
 * before/after 快照与 reasons。React 不重推业务语义，只消费本服务输出。
 */
@Injectable()
export class PlanCompareService {
  private readonly logger = new Logger(PlanCompareService.name);

  compare(baseline: SchedulingPlanV2, candidate: SchedulingPlanV2): PlanCompareResult {
    const aByTask = new Map(baseline.assignments.map((x) => [x.taskId, x]));
    const bByTask = new Map(candidate.assignments.map((x) => [x.taskId, x]));
    const allTaskIds = new Set([...aByTask.keys(), ...bByTask.keys()]);

    const diffByTask: PlanAssignmentDiff[] = [];
    const added: string[] = [];
    const removed: string[] = [];
    const changeTypeCounts: Record<PlanDiffChangeType, number> = {
      ADDED: 0,
      REMOVED: 0,
      PERSON_CHANGED: 0,
      DEVICE_CHANGED: 0,
      STATION_CHANGED: 0,
      TIME_CHANGED: 0,
      ROUTE_CHANGED: 0,
      ETA_CHANGED: 0,
      DISTANCE_CHANGED: 0,
      WORKLOAD_CHANGED: 0,
      LATENESS_CHANGED: 0,
      RISK_CHANGED: 0,
      CONFLICT_CHANGED: 0,
      CHURN: 0,
    };

    for (const taskId of allTaskIds) {
      const x = aByTask.get(taskId);
      const y = bByTask.get(taskId);
      const before = x ? this.toSnapshot(x) : undefined;
      const after = y ? this.toSnapshot(y) : undefined;

      if (x && !y) {
        removed.push(taskId);
        diffByTask.push({
          taskId,
          changeTypes: ['REMOVED'],
          before,
          after: undefined,
          reasons: ['assignment removed in candidate plan'],
        });
        changeTypeCounts.REMOVED += 1;
        continue;
      }
      if (!x && y) {
        added.push(taskId);
        diffByTask.push({
          taskId,
          changeTypes: ['ADDED'],
          before: undefined,
          after,
          reasons: ['assignment added in candidate plan'],
        });
        changeTypeCounts.ADDED += 1;
        continue;
      }

      const changeTypes: PlanDiffChangeType[] = [];
      const reasons: string[] = [];
      if (x!.personId !== y!.personId) {
        changeTypes.push('PERSON_CHANGED');
        reasons.push(`person ${x!.personId ?? 'none'} → ${y!.personId ?? 'none'}`);
      }
      if (x!.deviceId !== y!.deviceId) {
        changeTypes.push('DEVICE_CHANGED');
        reasons.push(`device ${x!.deviceId ?? 'none'} → ${y!.deviceId ?? 'none'}`);
      }
      if (x!.stationId !== y!.stationId) {
        changeTypes.push('STATION_CHANGED');
        reasons.push(`station ${x!.stationId ?? 'none'} → ${y!.stationId ?? 'none'}`);
      }
      if (x!.plannedStart !== y!.plannedStart || x!.plannedEnd !== y!.plannedEnd) {
        changeTypes.push('TIME_CHANGED');
        reasons.push(
          `window ${x!.plannedStart ?? '?'}~${x!.plannedEnd ?? '?'} → ${y!.plannedStart ?? '?'}~${y!.plannedEnd ?? '?'}`,
        );
      }
      if (x!.routeId !== y!.routeId) {
        changeTypes.push('ROUTE_CHANGED');
        reasons.push(`route ${x!.routeId ?? 'none'} → ${y!.routeId ?? 'none'}`);
      }
      if (x!.etaSeconds !== y!.etaSeconds) {
        changeTypes.push('ETA_CHANGED');
        reasons.push(`eta ${x!.etaSeconds ?? '?'}s → ${y!.etaSeconds ?? '?'}s`);
      }
      if (x!.distanceMeters !== y!.distanceMeters) {
        changeTypes.push('DISTANCE_CHANGED');
        reasons.push(
          `distance ${x!.distanceMeters ?? '?'}m → ${y!.distanceMeters ?? '?'}m`,
        );
      }
      if (x!.riskLevel !== y!.riskLevel) {
        changeTypes.push('RISK_CHANGED');
        reasons.push(`risk ${x!.riskLevel ?? 'none'} → ${y!.riskLevel ?? 'none'}`);
      }

      if (changeTypes.length === 0) continue;
      for (const t of changeTypes) changeTypeCounts[t] += 1;
      diffByTask.push({ taskId, changeTypes, before, after, reasons });
    }

    // CHURN：变更任务数 / 基线任务总数（代理，与 replan churn 语义一致）。
    // NEST-025 修复（2026-08-17）：分子双重计数——diffByTask 的键集已涵盖
    // added/removed 任务（同 taskId 进 diff 分支），旧公式 added+removed+diff
    // 使每个新增/删除任务计 2 次（churn=2*(A+R)+C）。churn 语义 = 发生变化的
    // 任务占比，分子取 diffByTask.length 即可（其内已含 added/removed 任务的
    // 字段级 diff 行）。
    const churn =
      aByTask.size > 0 ? diffByTask.length / aByTask.size : 0;
    changeTypeCounts.CHURN = Number(churn.toFixed(4));

    return {
      baselinePlanId: baseline.planId,
      candidatePlanId: candidate.planId,
      added,
      removed,
      diffByTask,
      changeTypeCounts,
      churn,
      aggregate: {
        baselineKpi: null,
        candidateKpi: null,
      },
    };
  }

  private toSnapshot(
    a: SchedulingPlanV2['assignments'][number],
  ): AssignmentSnapshot {
    return {
      taskId: a.taskId,
      personId: a.personId ?? null,
      deviceId: a.deviceId ?? null,
      stationId: a.stationId ?? null,
      plannedStart: a.plannedStart ?? null,
      plannedEnd: a.plannedEnd ?? null,
      etaSeconds: a.etaSeconds,
      distanceMeters: a.distanceMeters,
      riskLevel: a.riskLevel ?? null,
      routeGeometry: a.routeGeometry,
    };
  }
}
