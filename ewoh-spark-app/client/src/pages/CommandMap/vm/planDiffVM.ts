/* Phase 3 / P3-T3 前端：方案对比展示 VM（纯函数，不做资格/成本计算）。
 *
 * 输入 = 后端返回的 before/after SchedulingPlanV2（来源：plan compare 端点 /
 * applyOverrides diff），输出 = 前端展示模型：
 * - 变更分配（taskId + before/after + person/device/station 变化标记）；
 * - 指标增量（travel ETA / lateness / workload / waiting / risk / churn count）。
 * 纯展示：不重新计算任何调度指标，只透传后端字段并做差分展示。
 */
import type { SchedulingPlanV2 } from '@shared/api.interface';

export interface AssignmentDiff {
  taskId: string;
  beforePersonId: string | null;
  afterPersonId: string | null;
  beforeDeviceId: string | null;
  afterDeviceId: string | null;
  beforeStationId: string | null;
  afterStationId: string | null;
  personChanged: boolean;
  deviceChanged: boolean;
  stationChanged: boolean;
  timeChanged: boolean;
  /** 估算耗时增量（ms，after - before；缺字段为 null）。 */
  travelEtaDeltaMs: number | null;
  /** 距离增量（m）。 */
  distanceDeltaMeters: number | null;
  /** 迟到分钟增量（scoreBreakdown.lateness 分钟）。 */
  latenessDeltaMinutes: number | null;
  /** 负荷增量（scoreBreakdown.workloadBalance 分钟）。 */
  workloadDeltaMinutes: number | null;
  /** 等待增量（scoreBreakdown.stationWait 分钟）。 */
  waitingDeltaMinutes: number | null;
  /** 风险增量（scoreBreakdown.risk 分钟）。 */
  riskDeltaMinutes: number | null;
}

export interface PlanDiffVM {
  changedAssignments: AssignmentDiff[];
  addedTaskIds: string[];
  removedTaskIds: string[];
  /** 相对基线改派/增删的任务数。 */
  churnCount: number;
  metricsDelta: {
    lateMinutes: number;
    walkingMeters: number;
    stationWaitMinutes: number;
    maxWorkload: number;
    changeCost: number;
  } | null;
}

function isoToMs(iso?: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function breakdownDelta(
  before: SchedulingPlanV2['scoreBreakdown'] | undefined,
  after: SchedulingPlanV2['scoreBreakdown'] | undefined,
  key: 'lateness' | 'travel' | 'workloadBalance' | 'stationWait' | 'risk',
): number | null {
  const b = before?.[key];
  const a = after?.[key];
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  return a - b;
}

/** 纯函数：两个方案 → 展示用 diff 模型（不猜测/不重算）。 */
export function planDiffVM(before: SchedulingPlanV2, after: SchedulingPlanV2): PlanDiffVM {
  const beforeByTask = new Map(before.assignments.map((a) => [a.taskId, a]));
  const afterByTask = new Map(after.assignments.map((a) => [a.taskId, a]));

  const changedAssignments: AssignmentDiff[] = [];
  const addedTaskIds: string[] = [];
  const removedTaskIds: string[] = [];

  for (const taskId of new Set([...beforeByTask.keys(), ...afterByTask.keys()])) {
    const b = beforeByTask.get(taskId);
    const a = afterByTask.get(taskId);
    if (!b) {
      addedTaskIds.push(taskId);
      continue;
    }
    if (!a) {
      removedTaskIds.push(taskId);
      continue;
    }
    const personChanged = b.personId !== a.personId;
    const deviceChanged = b.deviceId !== a.deviceId;
    const stationChanged = b.stationId !== a.stationId;
    const timeChanged = isoToMs(b.plannedStart) !== isoToMs(a.plannedStart);
    if (!personChanged && !deviceChanged && !stationChanged && !timeChanged) continue;
    changedAssignments.push({
      taskId,
      beforePersonId: b.personId ?? null,
      afterPersonId: a.personId ?? null,
      beforeDeviceId: b.deviceId ?? null,
      afterDeviceId: a.deviceId ?? null,
      beforeStationId: b.stationId ?? null,
      afterStationId: a.stationId ?? null,
      personChanged,
      deviceChanged,
      stationChanged,
      timeChanged,
      travelEtaDeltaMs:
        a.etaSeconds != null && b.etaSeconds != null
          ? (a.etaSeconds - b.etaSeconds) * 1000
          : null,
      distanceDeltaMeters:
        a.distanceMeters != null && b.distanceMeters != null
          ? a.distanceMeters - b.distanceMeters
          : null,
      latenessDeltaMinutes: breakdownDelta(
        b.scoreBreakdown,
        a.scoreBreakdown,
        'lateness',
      ),
      workloadDeltaMinutes: breakdownDelta(
        b.scoreBreakdown,
        a.scoreBreakdown,
        'workloadBalance',
      ),
      waitingDeltaMinutes: breakdownDelta(
        b.scoreBreakdown,
        a.scoreBreakdown,
        'stationWait',
      ),
      riskDeltaMinutes: breakdownDelta(b.scoreBreakdown, a.scoreBreakdown, 'risk'),
    });
  }

  const churnCount =
    changedAssignments.length + addedTaskIds.length + removedTaskIds.length;

  const bm = before.metrics;
  const am = after.metrics;
  const metricsDelta =
    bm && am
      ? {
          lateMinutes: am.lateMinutes - bm.lateMinutes,
          walkingMeters: am.walkingMeters - bm.walkingMeters,
          stationWaitMinutes: am.stationWaitMinutes - bm.stationWaitMinutes,
          maxWorkload: am.maxWorkload - bm.maxWorkload,
          changeCost: am.changeCost - bm.changeCost,
        }
      : null;

  return { changedAssignments, addedTaskIds, removedTaskIds, churnCount, metricsDelta };
}
