/* Task 1 / P0：reuseBaseline fast-path（flag-gated，默认 OFF）机制验证。
 *
 * - 未传 reuseBaseline（或传空 Map）→ 行为与全量重排完全一致。
 * - 有效复用条目 → 直接采纳（decisionTrace.reused === true，
 *   reasons 含 unchanged_assignment_reused），person/device/station 与基线一致。
 * - 受影响任务（技能变更）→ 重新枚举（reused 不为 true）。
 * - 无效复用条目（设备离线 / 人员预订冲突）→ 回退完整枚举，仍满足不变量。
 */
/// <reference types="jest" />
import { HeuristicSchedulingSolver } from '../heuristic-scheduling-solver';
import { EligibilityService } from '../eligibility.service';
import { PriorityEngine } from '../priority-engine';
import type { SchedulingPlanV2, WorldStateSnapshot } from '@shared/api.interface';
import {
  person as seedPerson,
  task as seedTask,
  device as seedDevice,
  buildSnapshot,
  defaultPolicy,
  defaultConfig,
} from './scheduler-test-helpers';

jest.setTimeout(60_000);

function makeSolver() {
  const policy = {
    getActivePolicy: async () => defaultPolicy(),
    getConfig: async () => defaultConfig(),
  };
  const routeCostProvider = {
    estimate: async (
      personId: string,
      taskId: string,
      from?: { x: number; y: number },
      to?: { x: number; y: number },
    ) => {
      const dx = (to?.x ?? 0) - (from?.x ?? 0);
      const dy = (to?.y ?? 0) - (from?.y ?? 0);
      const dist = Math.hypot(dx, dy);
      return {
        routeId: null,
        distanceMeters: dist,
        etaSeconds: 10,
        riskLevel: null,
        feasible: true,
        source: 'euclidean_fallback' as const,
        riskCost: 0,
        congestionCost: 0,
        graphVersion: null,
        calculatedAt: new Date().toISOString(),
      };
    },
  };
  const solver = new HeuristicSchedulingSolver(
    policy as never,
    null as never,
    routeCostProvider as never,
    new EligibilityService(),
    new PriorityEngine(),
  );
  return { solver };
}

function baseSnapshot(): WorldStateSnapshot {
  const now = Date.now();
  return buildSnapshot({
    persons: [seedPerson({ id: 'p1' }), seedPerson({ id: 'p2', load: 0.2 })],
    tasks: [
      {
        ...seedTask({
          id: 't1',
          planStart: new Date(now + 10 * 60 * 1000).toISOString(),
          planEnd: new Date(now + 40 * 60 * 1000).toISOString(),
        }),
        stationId: 'S1',
        requiredSkills: ['work'],
      },
      { ...seedTask({ id: 't2' }), stationId: 'S1', requiredSkills: ['work'] },
    ],
    devices: [seedDevice({ id: 'd1' }), seedDevice({ id: 'd2' })],
    stations: [{ id: 'S1', name: 'S1', x: 0, y: 0, capacity: 4 }],
  });
}

function baseOpts(snapshot: WorldStateSnapshot, extra: Record<string, unknown> = {}) {
  return {
    planId: 'P',
    triggerType: 'MANUAL',
    triggerEntityId: null,
    snapshotVersion: snapshot.snapshotVersion,
    horizonMinutes: 480,
    policy: defaultPolicy(),
    ...extra,
  };
}

const reusedFlag = (a: SchedulingPlanV2['assignments'][number]) =>
  (a.decisionTrace as typeof a.decisionTrace & { reused?: boolean }).reused === true;

describe('reuseBaseline fast-path', () => {
  it('默认（未传/空 Map）行为与全量重排完全一致', async () => {
    const { solver } = makeSolver();
    const snap = baseSnapshot();
    const fixedNow = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(fixedNow);
    try {
      const planA = await solver.solve(snap, [], baseOpts(snap));
      const planB = await solver.solve(snap, [], baseOpts(snap, { reuseBaseline: new Map() }));
      expect(planA.assignments).toEqual(planB.assignments);
      expect(planB.assignments.every((a) => !reusedFlag(a))).toBe(true);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('有效复用条目被直接采纳（reused=true，reasons 含 unchanged_assignment_reused）', async () => {
    const { solver } = makeSolver();
    const snap = baseSnapshot();
    const fixedNow = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(fixedNow);
    try {
      const baseline = await solver.solve(snap, [], baseOpts(snap));
      const reuseMap = new Map<string, { personId: string; deviceId: string | null; stationId: string | null }>();
      for (const a of baseline.assignments) {
        reuseMap.set(a.taskId, { personId: a.personId!, deviceId: a.deviceId, stationId: a.stationId });
      }
      const plan2 = await solver.solve(snap, [], baseOpts(snap, { reuseBaseline: reuseMap }));
      expect(plan2.assignments).toHaveLength(baseline.assignments.length);
      for (const a of plan2.assignments) {
        expect(reusedFlag(a)).toBe(true);
        expect(a.reasons).toContain('unchanged_assignment_reused');
        expect(a.decisionTrace?.selectedReason).toContain('unchanged_assignment_reused');
        const b = baseline.assignments.find((x) => x.taskId === a.taskId)!;
        expect(a.personId).toBe(b.personId);
        expect(a.deviceId).toBe(b.deviceId);
        expect(a.stationId).toBe(b.stationId);
        expect(a.plannedStart).toBe(b.plannedStart);
        expect(a.plannedEnd).toBe(b.plannedEnd);
      }
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('受影响任务（技能变更）重新枚举，不复用', async () => {
    const { solver } = makeSolver();
    const snap = baseSnapshot();
    const snap2: WorldStateSnapshot = {
      ...snap,
      tasks: snap.tasks.map((t) =>
        t.id === 't2' ? { ...t, requiredSkills: ['welding'] } : t,
      ),
    };
    const fixedNow = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(fixedNow);
    try {
      const baseline = await solver.solve(snap, [], baseOpts(snap));
      const reuseMap = new Map<string, { personId: string; deviceId: string | null; stationId: string | null }>();
      for (const a of baseline.assignments) {
        reuseMap.set(a.taskId, { personId: a.personId!, deviceId: a.deviceId, stationId: a.stationId });
      }
      const plan2 = await solver.solve(snap2, [], baseOpts(snap2, { reuseBaseline: reuseMap }));
      const t1 = plan2.assignments.find((a) => a.taskId === 't1');
      const t2 = plan2.assignments.find((a) => a.taskId === 't2');
      // t1（未受影响）被复用；t2（技能变更）重新枚举后无人满足 → 未分配。
      expect(t1).toBeDefined();
      expect(reusedFlag(t1!)).toBe(true);
      expect(t2).toBeUndefined();
      expect(
        plan2.violations.some(
          (v) => (v as { taskId?: string; reason?: string }).taskId === 't2',
        ),
      ).toBe(true);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('无效复用条目（设备离线）回退完整枚举，结果仍满足不变量', async () => {
    const { solver } = makeSolver();
    const snap: WorldStateSnapshot = {
      ...baseSnapshot(),
      devices: baseSnapshot().devices.map((d) =>
        d.id === 'd1' ? { ...d, online: false } : d,
      ),
    };
    const reuseMap = new Map<string, { personId: string; deviceId: string | null; stationId: string | null }>([
      ['t1', { personId: 'p1', deviceId: 'd1', stationId: 'S1' }],
      ['t2', { personId: 'p2', deviceId: 'd2', stationId: 'S1' }],
    ]);
    const plan = await solver.solve(snap, [], baseOpts(snap, { reuseBaseline: reuseMap }));
    const t1 = plan.assignments.find((a) => a.taskId === 't1');
    expect(t1).toBeDefined();
    // d1 离线 → t1 不能复用 d1，必须回退枚举。
    expect(reusedFlag(t1!)).toBe(false);
    expect(t1!.deviceId).not.toBe('d1');
    if (t1!.deviceId) {
      const d = snap.devices.find((x) => x.id === t1!.deviceId)!;
      expect(d.online).toBe(true);
    }
  });

  it('无效复用条目（人员预订冲突）回退完整枚举，改派他人', async () => {
    const { solver } = makeSolver();
    const now = Date.now();
    const snap: WorldStateSnapshot = {
      ...baseSnapshot(),
      reservations: [
        {
          reservationId: 'R-1',
          resourceType: 'person',
          resourceId: 'p1',
          startMs: now + 5 * 60 * 1000,
          endMs: now + 50 * 60 * 1000,
        },
      ],
    };
    const reuseMap = new Map<string, { personId: string; deviceId: string | null; stationId: string | null }>([
      ['t1', { personId: 'p1', deviceId: 'd1', stationId: 'S1' }],
    ]);
    const plan = await solver.solve(snap, [], baseOpts(snap, { reuseBaseline: reuseMap }));
    const t1 = plan.assignments.find((a) => a.taskId === 't1');
    // p1 在 t1 窗口被 reservation 占用 → 复用校验失败 → 回退枚举改派 p2。
    expect(t1).toBeDefined();
    expect(reusedFlag(t1!)).toBe(false);
    expect(t1!.personId).toBe('p2');
  });
});
