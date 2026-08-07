import type { SchedulingPlanV2 } from '@shared/api.interface';
import {
  person as seedPerson,
  task as seedTask,
  device as seedDevice,
  buildSnapshot,
  defaultPolicy,
  baseSolveOpts,
  makeSolver,
} from './scheduler-test-helpers';

/** 剥离时间戳，比较方案的结构性结果。 */
function structural(plan: SchedulingPlanV2) {
  const { createdAt: _ca, ...rest } = plan;
  return rest;
}

describe('Solver invariants（确定性 / 不变量）', () => {
  it('同一资源不能时间重叠（多人多任务交叉验证）', async () => {
    const { solver } = makeSolver();
    const plan = await solver.solve(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1' })],
        tasks: [seedTask({ id: 't1' }), seedTask({ id: 't2' }), seedTask({ id: 't3' })],
        devices: [seedDevice({ id: 'd1' })],
      }),
      [],
      { ...baseSolveOpts, policy: defaultPolicy() },
    );
    const sorted = [...plan.assignments].sort(
      (a, b) => Date.parse(a.plannedStart!) - Date.parse(b.plannedStart!),
    );
    for (let i = 1; i < sorted.length; i++) {
      expect(Date.parse(sorted[i - 1].plannedEnd!)).toBeLessThanOrEqual(
        Date.parse(sorted[i].plannedStart!),
      );
    }
  });

  it('predecessor 一定先于 successor 被调度', async () => {
    const { solver } = makeSolver();
    const plan = await solver.solve(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1' })],
        tasks: [
          seedTask({ id: 't-pred' }),
          seedTask({ id: 't-a', predecessorIds: ['t-pred'] }),
        ],
        devices: [seedDevice({ id: 'd1' })],
      }),
      [],
      { ...baseSolveOpts, policy: defaultPolicy() },
    );
    const asg = plan.assignments;
    expect(asg).toHaveLength(2);
    const pred = asg.find((a) => a.taskId === 't-pred')!;
    const succ = asg.find((a) => a.taskId === 't-a')!;
    expect(Date.parse(pred.plannedEnd!)).toBeLessThanOrEqual(
      Date.parse(succ.plannedStart!),
    );
  });

  it('forbidden zone 不会产生 assignment', async () => {
    const { solver } = makeSolver();
    const plan = await solver.solve(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1' })],
        tasks: [seedTask({ id: 't1', zoneId: 'Z-FORBIDDEN' })],
        devices: [seedDevice({ id: 'd1' })],
        forbiddenZones: [{ zoneId: 'Z-FORBIDDEN', reason: 'restricted_zone' }],
      }),
      [],
      { ...baseSolveOpts, policy: defaultPolicy() },
    );
    expect(plan.assignments).toHaveLength(0);
  });

  it('不满足资质不能派', async () => {
    const { solver } = makeSolver();
    const plan = await solver.solve(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1', skills: ['welding'] })],
        tasks: [seedTask({ id: 't1', taskType: 'work' })],
        devices: [seedDevice({ id: 'd1' })],
      }),
      [],
      { ...baseSolveOpts, policy: defaultPolicy() },
    );
    expect(plan.assignments).toHaveLength(0);
  });

  it('executing/locked 任务在重排时不被改变', async () => {
    const { solver } = makeSolver();
    const plan = await solver.solve(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1' }), seedPerson({ id: 'p2' })],
        tasks: [
          { ...seedTask({ id: 't-exec', status: 'executing' }), assigneeId: 'p1' },
          seedTask({ id: 't-pending' }),
        ],
        devices: [seedDevice({ id: 'd1' })],
        lockedAssignments: [
          { taskId: 't-exec', personId: 'p1', deviceId: null, stationId: null },
        ],
      }),
      [],
      { ...baseSolveOpts, policy: defaultPolicy() },
    );
    expect(plan.assignments.some((a) => a.taskId === 't-exec')).toBe(false);
    expect(plan.assignments.some((a) => a.taskId === 't-pending')).toBe(true);
  });

  it('同 snapshot + policy + solverVersion 结果可确定性重放（两次 solve 输出完全一致）', async () => {
    const { solver } = makeSolver();
    const snapshot = buildSnapshot({
      persons: [seedPerson({ id: 'p1' }), seedPerson({ id: 'p2', load: 0.5 })],
      tasks: [seedTask({ id: 't1' }), seedTask({ id: 't2', priority: 'high' })],
      devices: [seedDevice({ id: 'd1' })],
    });
    const opts = { ...baseSolveOpts, policy: defaultPolicy() };

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
});