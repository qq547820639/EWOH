/* Task 1 / P0：优化后求解器性能与语义保全验证（solver-perf-parity）。
 *
 * 1) 确定性重放：同一快照两次 solve → assignments/metrics/violations 深相等
 *    （验证 route-cost memo、staged pipeline、top-K、紧凑 trace 不破坏确定性）。
 * 2) 硬不变量校验：生成的 500 任务快照求解后逐条校验
 *    （技能匹配 / 无人员双重预订 / 无设备双重预订 / 工位容量 / mustFinishBy /
 *    所有被拒候选均有原因 / trace 候选明细受 top-K 上限约束）。
 */
/// <reference types="jest" />
import { HeuristicSchedulingSolver } from '../heuristic-scheduling-solver';
import { EligibilityService } from '../eligibility.service';
import { PriorityEngine } from '../priority-engine';
import type {
  SchedulingPlanV2,
  WorldStateSnapshot,
} from '@shared/api.interface';
import { defaultPolicy, defaultConfig } from './scheduler-test-helpers';

jest.setTimeout(180_000);

/** 确定性伪随机（与 benchmark-scheduler.ts 同实现）。 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成与 benchmark 同构的合成快照（含工位容量/硬截止/技能不匹配人员，用于不变量校验）。 */
function buildBenchSnapshot(
  nTasks: number,
  nPersons: number,
  nDevices: number,
  seed: number,
): WorldStateSnapshot {
  const rnd = mulberry32(seed);
  const nowMs = Date.now();
  const horizonEndMs = nowMs + 480 * 60 * 1000;

  const stations = Array.from({ length: 8 }, (_, i) => {
    const x = 120 + rnd() * 760;
    const y = 120 + rnd() * 460;
    return {
      id: `ST-${i + 1}`,
      name: `工位${i + 1}`,
      x: Math.round(x),
      y: Math.round(y),
      capacity: 3,
    };
  });

  const persons = Array.from({ length: nPersons }, (_, i) => {
    const st = stations[Math.floor(rnd() * stations.length)];
    // ~20% 人员缺少必需技能 'work'（触发 skill 预筛 compact reject 路径）。
    const hasWork = rnd() > 0.2;
    return {
      id: `P-${String(i + 1).padStart(3, '0')}`,
      name: `人员${i + 1}`,
      status: 'AVAILABLE',
      healthStatus: 'normal',
      skills: hasWork ? ['work', 'skill-' + (i % 3)] : ['aux'],
      certifications: [],
      loadLevel: Math.round(rnd() * 100) / 100,
      fatigueLevel: Math.round(rnd() * 100) / 100,
      stationId: st.id,
      zoneId: null,
      x: st.x,
      y: st.y,
      sourceTs: nowMs,
      freshnessMs: 60_000,
      dataQuality: 'FRESH' as const,
    };
  });

  const devices = Array.from({ length: nDevices }, (_, i) => ({
    id: `EXO-${String(i + 1).padStart(3, '0')}`,
    workerName: null,
    deviceModel: 'EWOH-L1',
    batteryPct: Math.round(20 + rnd() * 80),
    online: true,
    status: 'AVAILABLE',
    capabilities: ['lift', 'assist'],
    sourceTs: nowMs,
    freshnessMs: 60_000,
    dataQuality: 'FRESH' as const,
  }));

  const tasks = Array.from({ length: nTasks }, (_, i) => {
    const st = stations[Math.floor(rnd() * stations.length)];
    const needsDevice = rnd() < 0.5;
    const priority = ['low', 'medium', 'high', 'critical'][Math.floor(rnd() * 4)];
    const durationMs = 1_800_000;
    const startMs = nowMs + Math.floor(rnd() * 120 * 60 * 1000);
    const endMs = startMs + durationMs + Math.floor(rnd() * 30 * 60 * 1000);
    return {
      id: `TASK-${String(i + 1).padStart(3, '0')}`,
      title: `任务${i + 1}`,
      taskType: 'work',
      priority,
      status: 'pending',
      assigneeId: null,
      deviceId: null,
      stationId: st.id,
      zoneId: null,
      planStart: new Date(Math.min(startMs, horizonEndMs)).toISOString(),
      planEnd: new Date(Math.min(endMs, horizonEndMs)).toISOString(),
      progress: 0,
      predecessorIds: [],
      requiredSkills: ['work'],
      requiredCertifications: [],
      requiredDeviceCapabilities: needsDevice ? ['lift'] : undefined,
      // ~20% 任务带硬截止（mustFinishBy）。
      latestFinishMs: rnd() < 0.2 ? endMs + Math.floor(rnd() * 30 * 60 * 1000) : undefined,
    };
  });

  return {
    snapshotVersion: `WS-PARITY-${seed}`,
    ts: new Date(nowMs).toISOString(),
    worldVersion: 1,
    entityVersions: {},
    reservations: [],
    safetyBlockedPersonIds: [],
    persons,
    tasks,
    devices,
    stations,
    backlog: [],
    events: [],
    routeStatus: [],
    forbiddenZones: [],
    lockedAssignments: [],
  };
}

/** 构造最小 solver（真实 EligibilityService + 轻量 euclidean 路径 mock）。 */
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
        etaSeconds: dist,
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
  return { solver, policy, routeCostProvider };
}

/** 剥离时间戳，比较方案的结构性结果。 */
function structural(plan: SchedulingPlanV2) {
  const { createdAt: _ca, ...rest } = plan;
  return rest;
}

/** 硬不变量校验器（500 任务规模）。 */
function assertPlanInvariants(plan: SchedulingPlanV2, snapshot: WorldStateSnapshot) {
  const personById = new Map(snapshot.persons.map((p) => [p.id, p]));
  const deviceById = new Map(snapshot.devices.map((d) => [d.id, d]));
  const stationById = new Map(snapshot.stations.map((s) => [s.id, s]));
  const asg = plan.assignments;

  // 1) 技能匹配（skillMatchMode 缺省 ALL）。
  for (const a of asg) {
    const task = snapshot.tasks.find((t) => t.id === a.taskId);
    const person = personById.get(a.personId ?? '');
    expect(task).toBeDefined();
    expect(person).toBeDefined();
    const req = task!.requiredSkills ?? [];
    const mode = task!.skillMatchMode ?? 'ALL';
    const has =
      mode === 'ALL'
        ? req.every((s) => person!.skills.includes(s))
        : req.some((s) => person!.skills.includes(s));
    expect(has).toBe(true);
  }

  // 2) 无人员双重预订（区间不重叠）。
  const personIntervals = new Map<string, Array<[number, number]>>();
  for (const a of asg) {
    if (!a.personId) continue;
    const arr = personIntervals.get(a.personId) ?? [];
    arr.push([Date.parse(a.plannedStart ?? ''), Date.parse(a.plannedEnd ?? '')]);
    personIntervals.set(a.personId, arr);
  }
  for (const [, ivs] of personIntervals) {
    ivs.sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < ivs.length; i++) {
      expect(ivs[i - 1][1]).toBeLessThanOrEqual(ivs[i][0]);
    }
  }

  // 3) 无设备双重预订。
  const deviceIntervals = new Map<string, Array<[number, number]>>();
  for (const a of asg) {
    if (!a.deviceId) continue;
    const arr = deviceIntervals.get(a.deviceId) ?? [];
    arr.push([Date.parse(a.plannedStart ?? ''), Date.parse(a.plannedEnd ?? '')]);
    deviceIntervals.set(a.deviceId, arr);
  }
  for (const [, ivs] of deviceIntervals) {
    ivs.sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < ivs.length; i++) {
      expect(ivs[i - 1][1]).toBeLessThanOrEqual(ivs[i][0]);
    }
  }

  // 4) 工位容量（同一工位同时重叠任务数 <= capacity）。
  const stationIntervals = new Map<string, Array<[number, number]>>();
  for (const a of asg) {
    if (!a.stationId) continue;
    const arr = stationIntervals.get(a.stationId) ?? [];
    arr.push([Date.parse(a.plannedStart ?? ''), Date.parse(a.plannedEnd ?? '')]);
    stationIntervals.set(a.stationId, arr);
  }
  for (const [sid, ivs] of stationIntervals) {
    const capacity = stationById.get(sid)?.capacity ?? null;
    if (capacity == null || capacity < 0) continue;
    for (const [s, e] of ivs) {
      const overlap = ivs.filter(([s2, e2]) => s2 < e && s < e2).length;
      expect(overlap).toBeLessThanOrEqual(capacity);
    }
  }

  // 5) mustFinishBy（latestFinishMs）硬截止。
  for (const t of snapshot.tasks) {
    if (t.latestFinishMs == null) continue;
    const a = asg.find((x) => x.taskId === t.id);
    if (!a) continue; // 未分配任务允许（must_finish_by_violation 语义）
    expect(Date.parse(a.plannedEnd ?? '')).toBeLessThanOrEqual(t.latestFinishMs);
  }

  // 6) 所有被拒候选均有原因（rejectedHard 每条非空）。
  for (const a of asg) {
    const dt = a.decisionTrace as typeof a.decisionTrace & {
      rejectedHard?: Array<{ rejectReasons: string[] }>;
    };
    for (const r of dt?.rejectedHard ?? []) {
      expect(Array.isArray(r.rejectReasons)).toBe(true);
      expect(r.rejectReasons.length).toBeGreaterThan(0);
    }
  }

  // 7) trace 候选明细受 top-K 上限约束（默认 12）。
  for (const a of asg) {
    const dt = a.decisionTrace;
    expect(dt).toBeDefined();
    expect((dt?.candidates ?? []).length).toBeLessThanOrEqual(12);
    expect((dt?.rejectedAlternatives ?? []).length).toBeLessThanOrEqual(11);
  }
}

describe('Solver perf-parity（优化后语义保全）', () => {
  it('确定性重放：同一快照两次 solve → assignments/metrics/violations 完全一致', async () => {
    const { solver } = makeSolver();
    const snapshot = buildBenchSnapshot(150, 45, 22, 20260810);
    const opts = {
      planId: 'P',
      triggerType: 'MANUAL',
      triggerEntityId: null,
      snapshotVersion: snapshot.snapshotVersion,
      horizonMinutes: 480,
      policy: defaultPolicy(),
    };
    const fixedNow = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(fixedNow);
    try {
      const planA = await solver.solve(snapshot, [], opts);
      const planB = await solver.solve(snapshot, [], opts);
      expect(structural(planA)).toEqual(structural(planB));
      expect(planA.assignments).toEqual(planB.assignments);
      expect(planA.metrics).toEqual(planB.metrics);
      expect(planA.violations).toEqual(planB.violations);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('500 任务快照：硬不变量全部成立', async () => {
    const { solver } = makeSolver();
    const snapshot = buildBenchSnapshot(500, 150, 75, 20260810);
    const plan = await solver.solve(snapshot, [], {
      planId: 'P',
      triggerType: 'MANUAL',
      triggerEntityId: null,
      snapshotVersion: snapshot.snapshotVersion,
      horizonMinutes: 480,
      policy: defaultPolicy(),
    });
    expect(plan.assignments.length).toBeGreaterThan(0);
    expect(plan.solverStatus).toBe('HEURISTIC');
    assertPlanInvariants(plan, snapshot);
  });

  it('top-K 可配置：candidateTopK=3 时 trace 明细 <= 3，argmin 不变', async () => {
    const { solver } = makeSolver();
    const snapshot = buildBenchSnapshot(40, 12, 6, 20260810);
    const baseOpts = {
      planId: 'P',
      triggerType: 'MANUAL',
      triggerEntityId: null,
      snapshotVersion: snapshot.snapshotVersion,
      horizonMinutes: 480,
      policy: defaultPolicy(),
    };
    const fixedNow = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(fixedNow);
    try {
      const planFull = await solver.solve(snapshot, [], baseOpts);
      const planK3 = await solver.solve(snapshot, [], { ...baseOpts, candidateTopK: 3 });
      // argmin 不变：两次选中的分配完全一致（任务→人员/设备/工位）。
      const identity = (p: SchedulingPlanV2) =>
        p.assignments.map((a) => `${a.taskId}|${a.personId}|${a.deviceId}|${a.stationId}`).sort();
      expect(identity(planK3)).toEqual(identity(planFull));
      for (const a of planK3.assignments) {
        expect((a.decisionTrace?.candidates ?? []).length).toBeLessThanOrEqual(3);
      }
    } finally {
      jest.restoreAllMocks();
    }
  });
});
