import { EligibilityService } from '../eligibility.service';
import type { SolverConstraint } from '../solver.service';
import {
  person as seedPerson,
  task as seedTask,
  device as seedDevice,
  buildSnapshot,
  defaultPolicy,
  baseSolveOpts,
  makeSolver,
  makeEligibilityCtx,
} from './scheduler-test-helpers';

const svc = new EligibilityService();

/** 把 snapshot 任务 seed 转成资格服务期望的 EligibleTask（predIds）。 */
function eligibleTask(t: ReturnType<typeof seedTask>) {
  return {
    id: t.id,
    taskType: t.taskType,
    requiredSkills: t.requiredSkills,
    requiredCertifications: t.requiredCertifications,
    stationId: t.stationId,
    zoneId: t.zoneId,
    predIds: t.predecessorIds,
  };
}

function eligiblePerson(p: ReturnType<typeof seedPerson>) {
  return {
    id: p.id,
    status: p.status,
    skills: p.skills,
    certifications: p.certifications,
    stationId: p.stationId,
    loadLevel: p.loadLevel,
    fatigueLevel: p.fatigueLevel,
    healthStatus: p.healthStatus,
  };
}

describe('Hard constraints（15 类）', () => {
  it('REQUIRED_SKILL：人员缺技能 → ineligible', () => {
    const res = svc.check(
      eligiblePerson(seedPerson({ id: 'p1', skills: ['welding'] })),
      eligibleTask(seedTask({ id: 't1', taskType: 'work' })),
      null,
      makeEligibilityCtx(),
    );
    expect(res.eligible).toBe(false);
    expect(res.reasons).toContain('missing_skill');
  });

  it('REQUIRED_CERTIFICATION：人员缺资质 → ineligible', () => {
    const res = svc.check(
      eligiblePerson(seedPerson({ id: 'p1', certifications: [] })),
      eligibleTask(seedTask({ id: 't1', requiredCertifications: ['cert-a'] })),
      null,
      makeEligibilityCtx(),
    );
    expect(res.eligible).toBe(false);
    expect(res.reasons).toContain('missing_certification');
  });

  it('PERSON_AVAILABLE：人员 unavailable → ineligible', () => {
    const res = svc.check(
      eligiblePerson(seedPerson({ id: 'p1', status: 'unavailable' })),
      eligibleTask(seedTask({ id: 't1' })),
      null,
      makeEligibilityCtx(),
    );
    expect(res.eligible).toBe(false);
    expect(res.reasons).toContain('person_unavailable');
  });

  it('DEVICE_AVAILABLE：设备离线 → 回退到纯手工（不派缺勤设备）', async () => {
    const { solver } = makeSolver();
    const plan = await solver.solve(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1' })],
        tasks: [seedTask({ id: 't1' })],
        devices: [seedDevice({ id: 'd1', online: false })],
      }),
      [],
      { ...baseSolveOpts, policy: defaultPolicy() },
    );
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].deviceId).toBeNull();
  });

  it('DEVICE_AVAILABLE：设备离线 → 资格检查返回 device_offline', () => {
    const res = svc.check(
      eligiblePerson(seedPerson({ id: 'p1' })),
      eligibleTask(seedTask({ id: 't1' })),
      { id: 'd1', batteryPct: 100, online: false, status: 'online' },
      makeEligibilityCtx(),
    );
    expect(res.reasons).toContain('device_offline');
  });

  it('RESOURCE_TIME_WINDOW：时间窗冲突 → 记 time_conflict', () => {
    const res = svc.check(
      eligiblePerson(seedPerson({ id: 'p1' })),
      eligibleTask(seedTask({ id: 't1' })),
      null,
      makeEligibilityCtx({
        now: 0,
        bookedTimeSlots: [{ personId: 'p1', start: -5000, end: 5000 }],
      }),
    );
    expect(res.eligible).toBe(false);
    expect(res.reasons).toContain('time_conflict');
  });

  it('NO_DOUBLE_BOOKING：同一个人两次任务占用时间不重叠', async () => {
    const { solver } = makeSolver();
    const plan = await solver.solve(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1' })],
        tasks: [seedTask({ id: 't1' }), seedTask({ id: 't2' })],
        devices: [seedDevice({ id: 'd1' })],
      }),
      [],
      { ...baseSolveOpts, policy: defaultPolicy() },
    );
    expect(plan.assignments).toHaveLength(2);
    const sorted = [...plan.assignments].sort(
      (a, b) => Date.parse(a.plannedStart!) - Date.parse(b.plannedStart!),
    );
    expect(Date.parse(sorted[0].plannedEnd!)).toBeLessThanOrEqual(
      Date.parse(sorted[1].plannedStart!),
    );
  });

  it('PREDECESSOR：前置未完成 → 资格不通过', () => {
    const res = svc.check(
      eligiblePerson(seedPerson({ id: 'p1' })),
      eligibleTask(seedTask({ id: 't1', predecessorIds: ['pre'] })),
      null,
      makeEligibilityCtx({ predecessorDone: () => false }),
    );
    expect(res.eligible).toBe(false);
    expect(res.reasons).toContain('predecessor_pending');
  });

  it('PREDECESSOR：前置未完成 → 记 violation 不派工', async () => {
    const { solver } = makeSolver();
    const plan = await solver.solve(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1' })],
        tasks: [
          seedTask({ id: 't0', status: 'executing' }), // 前置，执行中未完成
          seedTask({ id: 't1', predecessorIds: ['t0'] }),
        ],
        devices: [seedDevice({ id: 'd1' })],
      }),
      [],
      { ...baseSolveOpts, policy: defaultPolicy() },
    );
    // t1 依赖未完成的 t0 → t1 不派工并记 violation。
    expect(plan.assignments.some((a) => a.taskId === 't1')).toBe(false);
    expect(plan.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: 't1', reason: 'predecessor_pending' }),
      ]),
    );
  });

  it('FORBIDDEN_ZONE：禁入区 → 资格不通过', () => {
    const res = svc.check(
      eligiblePerson(seedPerson({ id: 'p1' })),
      eligibleTask(seedTask({ id: 't1', zoneId: 'z-blocked' })),
      null,
      makeEligibilityCtx({ forbiddenZones: ['z-blocked'] }),
    );
    expect(res.eligible).toBe(false);
    expect(res.reasons).toContain('zone_forbidden');
  });

  it('FORBIDDEN_ZONE：禁入区不产生 assignment', async () => {
    const { solver } = makeSolver();
    const constraints: SolverConstraint[] = [
      { type: 'FORBIDDEN_ZONE', zoneId: 'z-blocked' },
    ];
    const plan = await solver.solve(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1' })],
        tasks: [seedTask({ id: 't1', zoneId: 'z-blocked' })],
        devices: [seedDevice({ id: 'd1' })],
      }),
      constraints,
      { ...baseSolveOpts, policy: defaultPolicy() },
    );
    expect(plan.assignments).toHaveLength(0);
    expect(plan.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: 't1', reason: 'no_eligible_resource' }),
      ]),
    );
  });

  it('MIN_BATTERY：电量不足设备 → 资格不通过', () => {
    const res = svc.check(
      eligiblePerson(seedPerson({ id: 'p1' })),
      eligibleTask(seedTask({ id: 't1' })),
      { id: 'd1', batteryPct: 5, online: true, status: 'online' },
      makeEligibilityCtx({ minBatteryPct: 15 }),
    );
    expect(res.reasons).toContain('battery_low');
  });

  it('MIN_BATTERY：低电量设备不派（回退手工）', async () => {
    const { solver } = makeSolver();
    const constraints: SolverConstraint[] = [{ type: 'MIN_BATTERY', value: 15 }];
    const plan = await solver.solve(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1' })],
        tasks: [seedTask({ id: 't1' })],
        devices: [seedDevice({ id: 'd1', battery: 5 })],
      }),
      constraints,
      { ...baseSolveOpts, policy: defaultPolicy() },
    );
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].deviceId).toBeNull();
  });

  it('MAX_WORKLOAD：超负荷人员 → 资格不通过', () => {
    const res = svc.check(
      eligiblePerson(seedPerson({ id: 'p1', load: 0.8 })),
      eligibleTask(seedTask({ id: 't1' })),
      null,
      makeEligibilityCtx({ maxContinuousLoad: 0.5 }),
    );
    expect(res.eligible).toBe(false);
    expect(res.reasons).toContain('continuous_work_exceeded');
  });

  it('MAX_WORKLOAD：超负荷人员不派（记 violation）', async () => {
    const { solver } = makeSolver();
    const constraints: SolverConstraint[] = [{ type: 'MAX_WORKLOAD', value: 0.5 }];
    const plan = await solver.solve(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1', load: 0.8 })],
        tasks: [seedTask({ id: 't1' })],
        devices: [seedDevice({ id: 'd1' })],
      }),
      constraints,
      { ...baseSolveOpts, policy: defaultPolicy() },
    );
    expect(plan.assignments).toHaveLength(0);
    expect(plan.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: 't1', reason: 'no_eligible_resource' }),
      ]),
    );
  });

  it('SAFETY_BLOCK：safetyBlockedPersonIds 中的人不派', async () => {
    const { solver } = makeSolver();
    const plan = await solver.solve(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1' })],
        tasks: [seedTask({ id: 't1' })],
        devices: [seedDevice({ id: 'd1' })],
        safetyBlockedPersonIds: ['p1'],
      }),
      [],
      { ...baseSolveOpts, policy: defaultPolicy() },
    );
    expect(plan.assignments).toHaveLength(0);
    expect(plan.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: 't1', reason: 'no_eligible_resource' }),
      ]),
    );
  });

  it('LOCKED_PERSON：锁定人员生效', async () => {
    const { solver } = makeSolver();
    const plan = await solver.solve(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1', load: 0.1 }), seedPerson({ id: 'p2', load: 0.8 })],
        tasks: [seedTask({ id: 't1' })],
        devices: [seedDevice({ id: 'd1' })],
      }),
      [{ type: 'LOCKED_PERSON', taskId: 't1', personId: 'p2' }],
      { ...baseSolveOpts, policy: defaultPolicy() },
    );
    expect(plan.assignments[0].personId).toBe('p2');
  });

  it('LOCKED_DEVICE：锁定设备生效', async () => {
    const { solver } = makeSolver();
    const plan = await solver.solve(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1' })],
        tasks: [seedTask({ id: 't1' })],
        devices: [seedDevice({ id: 'd1' }), seedDevice({ id: 'd2' })],
      }),
      [{ type: 'LOCKED_DEVICE', taskId: 't1', deviceId: 'd2' }],
      { ...baseSolveOpts, policy: defaultPolicy() },
    );
    expect(plan.assignments[0].deviceId).toBe('d2');
  });

  it('LOCKED_TIME：锁定时间窗生效', async () => {
    const { solver } = makeSolver();
    const startMs = 1_000_000;
    const endMs = 2_000_000;
    const plan = await solver.solve(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1' })],
        tasks: [seedTask({ id: 't1' })],
        devices: [seedDevice({ id: 'd1' })],
      }),
      [{ type: 'LOCKED_TIME', taskId: 't1', startMs, endMs }],
      { ...baseSolveOpts, policy: defaultPolicy() },
    );
    expect(plan.assignments[0].plannedStart).toBe(new Date(startMs).toISOString());
    expect(plan.assignments[0].plannedEnd).toBe(new Date(endMs).toISOString());
  });

  it('LOCKED_ASSIGNMENT：锁定人员+设备生效', async () => {
    const { solver } = makeSolver();
    const plan = await solver.solve(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1' }), seedPerson({ id: 'p2' })],
        tasks: [seedTask({ id: 't1' })],
        devices: [seedDevice({ id: 'd1' }), seedDevice({ id: 'd2' })],
      }),
      [{ type: 'LOCKED_ASSIGNMENT', taskId: 't1', personId: 'p2', deviceId: 'd2' }],
      { ...baseSolveOpts, policy: defaultPolicy() },
    );
    expect(plan.assignments[0].personId).toBe('p2');
    expect(plan.assignments[0].deviceId).toBe('d2');
  });
});