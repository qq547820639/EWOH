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
import { makeDispatchCoordinator, testOrgContext } from './dispatch-test-harness';

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
});