import { ReplanCoordinatorService } from '../replan-coordinator.service';
import { RequestDatabaseContext } from '@server/database/request-database-context';
import { TriggerService } from '../trigger.service';
import { WorldStateSnapshotService } from '../world-state.service';
import { SolverService } from '../solver.service';
import { PlanService } from '../plan.service';
import { SchedulingPolicyService } from '../scheduling-policy.service';
import type { WorldStateSnapshot } from '@shared/api.interface';
import {
  person as seedPerson,
  task as seedTask,
  device as seedDevice,
  buildSnapshot,
  defaultPolicy,
  baseSolveOpts,
  makeSolver,
} from './scheduler-test-helpers';

describe('Failure injection（故障注入）', () => {
  it('person unavailable → 记 violation 不派工', async () => {
    const { solver } = makeSolver();
    const plan = await solver.solve(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1', status: 'unavailable' })],
        tasks: [seedTask({ id: 't1' })],
        devices: [seedDevice({ id: 'd1' })],
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

  it('device offline → 回退纯手工（设备不可用仍产出方案）', async () => {
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

  it('low battery → 低电量设备不派（回退手工）', async () => {
    const { solver } = makeSolver();
    const plan = await solver.solve(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1' })],
        tasks: [seedTask({ id: 't1' })],
        devices: [seedDevice({ id: 'd1', battery: 5 })],
      }),
      [{ type: 'MIN_BATTERY', value: 15 }],
      { ...baseSolveOpts, policy: defaultPolicy() },
    );
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].deviceId).toBeNull();
  });

  it('blocked route（RoutingService 返回不可行）→ 不产生 assignment 并记 violation', async () => {
    const { solver, routeCostProvider } = makeSolver();
    routeCostProvider.estimate.mockResolvedValue({
      routeId: null,
      distanceMeters: 0,
      etaSeconds: 0,
      riskLevel: null,
      feasible: false,
    });
    const plan = await solver.solve(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1' })],
        tasks: [seedTask({ id: 't1' })],
        devices: [seedDevice({ id: 'd1' })],
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

  it('safety event（safetyBlockedPersonIds 生效）→ 被禁人员不派', async () => {
    const { solver } = makeSolver();
    const plan = await solver.solve(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1' }), seedPerson({ id: 'p2' })],
        tasks: [seedTask({ id: 't1' })],
        devices: [seedDevice({ id: 'd1' })],
        safetyBlockedPersonIds: ['p1'],
        forbiddenZones: [{ zoneId: 'z-safe', reason: 'safety_event' }],
      }),
      [],
      { ...baseSolveOpts, policy: defaultPolicy() },
    );
    // p1 因安全被禁，p2 仍可调度。
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].personId).toBe('p2');
  });

  it('deadline risk（任务带 deadlineAtRisk 标记）→ 优先级上升，优先占用更早时间窗', async () => {
    const { solver } = makeSolver();
    const plan = await solver.solve(
      buildSnapshot({
        persons: [seedPerson({ id: 'p1' })],
        tasks: [
          { ...seedTask({ id: 't-at-risk' }), deadlineAtRisk: true } as WorldStateSnapshot['tasks'][number],
          seedTask({ id: 't-normal' }),
        ],
        devices: [seedDevice({ id: 'd1' })],
      }),
      [],
      { ...baseSolveOpts, policy: defaultPolicy() },
    );
    expect(plan.assignments).toHaveLength(2);
    const startOf = (taskId: string) => {
      const a = plan.assignments.find((x) => x.taskId === taskId)!;
      return Date.parse(a.plannedStart!);
    };
    expect(startOf('t-at-risk')).toBeLessThan(startOf('t-normal'));
  });
});

describe('ReplanCoordinatorService.impactAnalysis（重排影响分析）', () => {
  function makeReplanService() {
    const svc = new ReplanCoordinatorService(
      {} as never,
      {} as RequestDatabaseContext,
      {} as TriggerService,
      {} as WorldStateSnapshotService,
      {} as SolverService,
      {} as PlanService,
      {} as SchedulingPolicyService,
    );
    return svc;
  }

  it('SAFETY_EVENT：受影响任务 + 下游传递，冻结 executing 任务', async () => {
    const svc = makeReplanService();
    const snapshot = buildSnapshot({
      tasks: [
        seedTask({ id: 't-affected', zoneId: 'z-factory' }),
        { ...seedTask({ id: 't-exec', status: 'executing' }), assigneeId: 'p1', zoneId: 'z-factory' },
        seedTask({ id: 't-other', zoneId: 'z-other' }),
        seedTask({ id: 't-dep', zoneId: 'z-other', predecessorIds: ['t-affected'] }),
      ],
      forbiddenZones: [{ zoneId: 'z-factory', reason: 'safety_event' }],
      lockedAssignments: [
        { taskId: 't-exec', personId: 'p1', deviceId: null, stationId: null },
      ],
    });

    const result = await svc.impactAnalysis(snapshot, 'SAFETY_EVENT', 'z-factory');
    expect(result.affectedTaskIds).toEqual(
      expect.arrayContaining(['t-affected', 't-dep']),
    );
    expect(result.affectedTaskIds).not.toContain('t-exec');
    expect(result.frozenTaskIds).toContain('t-exec');
  });

  it('DEVICE_OFFLINE：仅影响使用该设备的待办任务', async () => {
    const svc = makeReplanService();
    const snapshot = buildSnapshot({
      tasks: [
        { ...seedTask({ id: 't1' }), deviceId: 'd1' },
        { ...seedTask({ id: 't2' }), deviceId: 'd2' },
      ],
    });
    const result = await svc.impactAnalysis(snapshot, 'DEVICE_OFFLINE', 'd1');
    expect(result.affectedTaskIds).toEqual(['t1']);
    expect(result.affectedTaskIds).not.toContain('t2');
  });

  it('PERSON_UNAVAILABLE：仅影响分配给该人员的待办任务', async () => {
    const svc = makeReplanService();
    const snapshot = buildSnapshot({
      tasks: [
        { ...seedTask({ id: 't1' }), assigneeId: 'p1' },
        { ...seedTask({ id: 't2' }), assigneeId: 'p2' },
      ],
    });
    const result = await svc.impactAnalysis(snapshot, 'PERSON_UNAVAILABLE', 'p1');
    expect(result.affectedTaskIds).toEqual(['t1']);
  });
});