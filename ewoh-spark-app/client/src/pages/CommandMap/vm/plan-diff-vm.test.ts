/* Phase 3 / P3-T3：planDiffVM 纯函数测试。 */
import { planDiffVM } from './planDiffVM';
import type { SchedulingPlanV2 } from '@shared/api.interface';

function plan(
  planId: string,
  assignments: Array<{
    taskId: string;
    personId?: string;
    deviceId?: string;
    stationId?: string;
    plannedStart?: string;
    etaSeconds?: number;
    distanceMeters?: number;
    scoreBreakdown?: SchedulingPlanV2['scoreBreakdown'];
  }>,
): SchedulingPlanV2 {
  return {
    planId,
    planName: planId,
    version: 1,
    status: 'shadow',
    trigger: { type: 'MANUAL', entityId: null },
    snapshotVersion: 'WS-1',
    policyVersion: 1,
    solverVersion: 'heuristic-v2',
    horizonMinutes: 480,
    assignments: assignments.map((a) => ({
      assignmentId: `ASG-${planId}-${a.taskId}`,
      taskId: a.taskId,
      personId: a.personId ?? null,
      deviceId: a.deviceId ?? null,
      stationId: a.stationId ?? null,
      zoneId: null,
      plannedStart: a.plannedStart ?? '2026-08-09T00:00:00.000Z',
      plannedEnd: '2026-08-09T00:30:00.000Z',
      routeId: null,
      status: 'proposed',
      reasons: [],
      alternatives: [],
      etaSeconds: a.etaSeconds ?? 600,
      distanceMeters: a.distanceMeters ?? 100,
      scoreBreakdown: a.scoreBreakdown,
    })),
    metrics: {
      lateMinutes: 0,
      walkingMeters: 100,
      stationWaitMinutes: 0,
      maxWorkload: 1,
      changeCost: 0,
    },
    baselineDelta: {},
    violations: [],
    createdAt: '2026-08-09T00:00:00.000Z',
  };
}

describe('planDiffVM（方案对比展示）', () => {
  it('person 变更 → 标记 personChanged + travel ETA delta + churn', () => {
    const before = plan('P1', [
      { taskId: 't1', personId: 'p1', etaSeconds: 600, distanceMeters: 100 },
    ]);
    const after = plan('P1-R2', [
      { taskId: 't1', personId: 'p2', etaSeconds: 300, distanceMeters: 50 },
    ]);
    const diff = planDiffVM(before, after);
    expect(diff.changedAssignments).toHaveLength(1);
    const d = diff.changedAssignments[0];
    expect(d.taskId).toBe('t1');
    expect(d.personChanged).toBe(true);
    expect(d.deviceChanged).toBe(false);
    expect(d.travelEtaDeltaMs).toBe(-300_000);
    expect(d.distanceDeltaMeters).toBe(-50);
    expect(diff.churnCount).toBe(1);
  });

  it('新增/移除分配 → added/removed + churn 计数', () => {
    const before = plan('P1', [{ taskId: 't1', personId: 'p1' }]);
    const after = plan('P1-R2', [
      { taskId: 't1', personId: 'p1' },
      { taskId: 't2', personId: 'p2' },
    ]);
    const diff = planDiffVM(before, after);
    expect(diff.addedTaskIds).toEqual(['t2']);
    expect(diff.churnCount).toBe(1);
  });

  it('时间变更（plannedStart 不同）→ timeChanged=true', () => {
    const before = plan('P1', [
      { taskId: 't1', personId: 'p1', plannedStart: '2026-08-09T00:00:00.000Z' },
    ]);
    const after = plan('P1-R2', [
      { taskId: 't1', personId: 'p1', plannedStart: '2026-08-09T02:00:00.000Z' },
    ]);
    const diff = planDiffVM(before, after);
    expect(diff.changedAssignments[0].timeChanged).toBe(true);
  });

  it('无变化 → 空 diff（churn=0，不虚构）', () => {
    const p = plan('P1', [{ taskId: 't1', personId: 'p1' }]);
    const diff = planDiffVM(p, { ...p, planId: 'P1-R2' });
    expect(diff.changedAssignments).toHaveLength(0);
    expect(diff.churnCount).toBe(0);
  });

  it('scoreBreakdown delta：lateness/workload/waiting/risk 增量透传（缺字段为 null）', () => {
    const before = plan('P1', [
      {
        taskId: 't1',
        personId: 'p1',
        scoreBreakdown: {
          lateness: 1, travel: 2, workloadBalance: 3, stationWait: 4, changeCost: 0, risk: 5, energyCost: 0, total: 15,
        },
      },
    ]);
    const after = plan('P1-R2', [
      {
        taskId: 't1',
        personId: 'p2',
        scoreBreakdown: {
          lateness: 4, travel: 2, workloadBalance: 6, stationWait: 5, changeCost: 1, risk: 7, energyCost: 0, total: 25,
        },
      },
    ]);
    const diff = planDiffVM(before, after);
    const d = diff.changedAssignments[0];
    expect(d.latenessDeltaMinutes).toBe(3);
    expect(d.workloadDeltaMinutes).toBe(3);
    expect(d.waitingDeltaMinutes).toBe(1);
    expect(d.riskDeltaMinutes).toBe(2);
  });
});
