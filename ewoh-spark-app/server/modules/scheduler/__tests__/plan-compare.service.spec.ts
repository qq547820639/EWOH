import { PlanCompareService } from '../plan-compare.service';
import type { SchedulingPlanV2 } from '@shared/api.interface';

describe('PlanCompareService（P4-COMPARE：权威 Diff）', () => {
  const svc = new PlanCompareService();

  const plan = (planId: string, assignments: SchedulingPlanV2['assignments']): SchedulingPlanV2 =>
    ({
      planId,
      planName: planId,
      version: 1,
      status: 'proposed',
      trigger: { type: 'MANUAL', entityId: null },
      snapshotVersion: 'WS-1',
      policyVersion: 1,
      solverVersion: 'heuristic-v2',
      solverStatus: 'HEURISTIC',
      objective: 0,
      horizonMinutes: 480,
      assignments,
      violations: [],
      metrics: { lateMinutes: 0, walkingMeters: 0, stationWaitMinutes: 0, maxWorkload: 0, changeCost: 0 },
      baselineDelta: {},
      createdAt: '2026-01-01',
    }) as unknown as SchedulingPlanV2;

  const asg = (taskId: string, personId: string | null, stationId: string | null, plannedStart: string, etaSeconds = 60, distanceMeters = 100) => ({
    assignmentId: `ASG-${taskId}`,
    taskId,
    personId,
    deviceId: null,
    stationId,
    zoneId: null,
    plannedStart,
    plannedEnd: plannedStart,
    routeId: null,
    etaSeconds,
    distanceMeters,
    riskLevel: null,
    status: 'proposed' as const,
    reasons: [],
    alternatives: [],
  });

  it('相同方案 → 无 diff', () => {
    const a = plan('P1', [asg('T1', 'p1', 'S1', '2026-01-01T00:00:00Z')]);
    const b = plan('P2', [asg('T1', 'p1', 'S1', '2026-01-01T00:00:00Z')]);
    const r = svc.compare(a, b);
    expect(r.diffByTask).toHaveLength(0);
    expect(r.churn).toBe(0);
  });

  it('person 变更 + 时间变更 → PERSON_CHANGED/TIME_CHANGED', () => {
    const a = plan('P1', [asg('T1', 'p1', 'S1', '2026-01-01T00:00:00Z')]);
    const b = plan('P2', [asg('T1', 'p2', 'S1', '2026-01-01T00:30:00Z')]);
    const r = svc.compare(a, b);
    const diff = r.diffByTask.find((d) => d.taskId === 'T1')!;
    expect(diff.changeTypes).toContain('PERSON_CHANGED');
    expect(diff.changeTypes).toContain('TIME_CHANGED');
    expect(diff.before?.personId).toBe('p1');
    expect(diff.after?.personId).toBe('p2');
    expect(diff.reasons.length).toBeGreaterThan(0);
  });

  it('新增/移除 assignment → ADDED/REMOVED', () => {
    const a = plan('P1', [asg('T1', 'p1', 'S1', '2026-01-01T00:00:00Z')]);
    const b = plan('P2', [asg('T1', 'p1', 'S1', '2026-01-01T00:00:00Z'), asg('T2', 'p1', 'S2', '2026-01-01T01:00:00Z')]);
    const r = svc.compare(a, b);
    expect(r.added).toContain('T2');
    expect(r.diffByTask.find((d) => d.taskId === 'T2')?.changeTypes).toContain('ADDED');
  });

  it('churn = 变更任务数 / 基线任务数', () => {
    const a = plan('P1', [asg('T1', 'p1', 'S1', '2026-01-01T00:00:00Z')]);
    const b = plan('P2', [asg('T1', 'p2', 'S1', '2026-01-01T00:00:00Z')]);
    const r = svc.compare(a, b);
    expect(r.churn).toBe(1); // 1 变更 / 1 基线
    expect(r.changeTypeCounts.PERSON_CHANGED).toBe(1);
    expect(r.changeTypeCounts.CHURN).toBe(1);
  });
});
