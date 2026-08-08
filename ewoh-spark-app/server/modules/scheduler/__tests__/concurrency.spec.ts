import { ConflictException } from '@nestjs/common';
import {
  person as seedPerson,
  task as seedTask,
  device as seedDevice,
  buildSnapshot,
  defaultPolicy,
  baseSolveOpts,
  makeSolver,
} from './scheduler-test-helpers';
import {
  makeDispatchCoordinator,
  makeFakeDb,
  testOrgContext,
} from './dispatch-test-harness';
import { ResourceReservationService } from '../resource-reservation.service';
import { RequestDatabaseContext } from '@server/database/request-database-context';
import type { ReservationInput } from '../resource-reservation.service';

describe('并发 / 竞争测试', () => {
  it('两份 plan 同时 dispatch 只允许一份成功（CAS 抛 PLAN_CONCURRENT_DISPATCH）', async () => {
    const { svc, mocks } = makeDispatchCoordinator({
      forcePlanApproved: true,
      plans: [
        {
          planId: 'PLAN-1',
          planName: 'p1',
          strategy: 'scheduling_v2',
          status: 'approved',
          version: 1,
          snapshotVersion: 'WS-1',
        },
      ],
      assignments: [
        {
          assignmentId: 'ASG-1',
          planId: 'PLAN-1',
          taskId: 'TASK-1',
          personId: 'p1',
          deviceId: 'd1',
          plannedStart: new Date(1_000_000),
          plannedEnd: new Date(2_000_000),
          status: 'approved',
        },
      ],
      tasks: [{ id: 'TASK-1', status: 'pending_dispatch', version: 1 }],
    });
    mocks.reservationService.reserve.mockResolvedValue([]);
    mocks.outboxService.enqueue.mockResolvedValue({
      id: 'evt-x',
      eventType: 'assignment.dispatched',
      entityId: 'ASG-1',
      payload: {},
      status: 'pending',
      sequence: 1,
      createdAt: new Date().toISOString(),
    });

    const ctx = testOrgContext();
    const results = await Promise.allSettled([
      svc.dispatch('PLAN-1', ctx),
      svc.dispatch('PLAN-1', ctx),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as Error;
    expect(reason.message).toContain('PLAN_CONCURRENT_DISPATCH');
  });

  it('plan 非 approved 时 dispatch 被拒绝（PLAN_NOT_APPROVED）', async () => {
    const { svc } = makeDispatchCoordinator({
      plans: [
        {
          planId: 'PLAN-NOT-APPROVED',
          planName: 'p',
          strategy: 'scheduling_v2',
          status: 'shadow',
          version: 1,
          snapshotVersion: 'WS-1',
        },
      ],
      assignments: [],
      tasks: [],
    });
    await expect(svc.dispatch('PLAN-NOT-APPROVED', testOrgContext())).rejects.toThrow(
      'PLAN_NOT_APPROVED',
    );
  });

  it('两个 task 抢同一 person → 时间不重叠', async () => {
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

  it('两个 task 抢同一 device → 时间不重叠', async () => {
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
    expect(plan.assignments.every((a) => a.deviceId === 'd1')).toBe(true);
    const sorted = [...plan.assignments].sort(
      (a, b) => Date.parse(a.plannedStart!) - Date.parse(b.plannedStart!),
    );
    expect(Date.parse(sorted[0].plannedEnd!)).toBeLessThanOrEqual(
      Date.parse(sorted[1].plannedStart!),
    );
  });

  it('stale plan 与新世界状态并发 → 拒绝 stale（快照不新鲜抛 PLAN_STALE）', async () => {
    const { svc, state, mocks } = makeDispatchCoordinator({
      plans: [
        {
          planId: 'PLAN-STALE',
          planName: 'p',
          strategy: 'scheduling_v2',
          status: 'approved',
          version: 1,
          snapshotVersion: 'WS-OLD',
        },
      ],
      assignments: [
        {
          assignmentId: 'ASG-1',
          planId: 'PLAN-STALE',
          taskId: 'TASK-1',
          personId: 'p1',
          plannedStart: new Date(1_000_000),
          plannedEnd: new Date(2_000_000),
          status: 'approved',
        },
      ],
      tasks: [{ id: 'TASK-1', status: 'pending_dispatch', version: 1 }],
    });
    mocks.worldStateSnapshotService.assertFreshForApprove.mockRejectedValue(
      new ConflictException('PLAN_STALE'),
    );

    await expect(svc.dispatch('PLAN-STALE', testOrgContext())).rejects.toThrow(
      'PLAN_STALE',
    );
    // 拒绝后方案状态未被改变（保持 approved）。
    expect(state.plans.get('PLAN-STALE')?.status).toBe('approved');
  });

  it('dispatch 时为分配并发起工位预占（station），预占冲突使整体下发失败 RESOURCE_CONFLICT', async () => {
    const { svc, mocks } = makeDispatchCoordinator({
      forcePlanApproved: true,
      plans: [
        {
          planId: 'PLAN-STATION',
          planName: 'p',
          strategy: 'scheduling_v2',
          status: 'approved',
          version: 1,
          snapshotVersion: 'WS-1',
        },
      ],
      assignments: [
        {
          assignmentId: 'ASG-ST',
          planId: 'PLAN-STATION',
          taskId: 'TASK-1',
          personId: 'p1',
          stationId: 'ST1',
          plannedStart: new Date(1_000_000),
          plannedEnd: new Date(2_000_000),
          status: 'approved',
        },
      ],
      tasks: [{ id: 'TASK-1', status: 'pending_dispatch', version: 1 }],
    });

    let reserveInputs: ReservationInput[] = [];
    mocks.reservationService.reserve.mockImplementation(
      async (_planId, _assignmentId, _taskId, inputs) => {
        reserveInputs = inputs;
        throw new ConflictException('RESOURCE_CONFLICT');
      },
    );

    // 预占阶段把 stationId 以 resourceType='station' 传入保留服务。
    await expect(
      svc.dispatch('PLAN-STATION', testOrgContext()),
    ).rejects.toThrow('RESOURCE_CONFLICT');

    const station = reserveInputs.find((i) => i.resourceType === 'station');
    expect(station).toBeDefined();
    expect(station!.resourceId).toBe('ST1');
    expect(reserveInputs.map((i) => i.resourceType)).toEqual(
      expect.arrayContaining(['person', 'station']),
    );
  });

  it('同一工位重叠时间窗二次预占 → 第二次 RESOURCE_CONFLICT，DB 无重叠预占', async () => {
    const { db, state } = makeFakeDb();
    const requestDatabaseContext = {
      runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => {
        await cb();
      }),
    };
    const reservationSvc = new ResourceReservationService(
      db,
      requestDatabaseContext as unknown as RequestDatabaseContext,
    );
    const ctx = testOrgContext();

    // 第一次：工位 ST1 在 [1000, 2000] 预占成功。
    await reservationSvc.reserve(
      'PLAN-1',
      'ASG-1',
      'TASK-1',
      [{ resourceType: 'station', resourceId: 'ST1', startMs: 1000, endMs: 2000 }],
      ctx,
    );

    // 第二次：不同方案/任务，同一工位 ST1 重叠窗口 [1500, 2500] → 冲突。
    await expect(
      reservationSvc.reserve(
        'PLAN-2',
        'ASG-2',
        'TASK-2',
        [{ resourceType: 'station', resourceId: 'ST1', startMs: 1500, endMs: 2500 }],
        ctx,
      ),
    ).rejects.toThrow('RESOURCE_CONFLICT');

    // DB 中工位 ST1 仅存在一条活跃预占，无重叠。
    const stationReservations = state.reservations.filter(
      (r) => r.resourceType === 'station' && r.resourceId === 'ST1',
    );
    expect(stationReservations).toHaveLength(1);
    expect(stationReservations[0].status).toBe('reserved');
  });
});