import { DispatchCoordinatorService } from '../dispatch-coordinator.service';
import { PlanService } from '../plan.service';
import { validateDecision } from '@shared/decision';
import { RequestDatabaseContext } from '@server/database/request-database-context';
import { WorldStateSnapshotService } from '../world-state.service';
import { ResourceReservationService } from '../resource-reservation.service';
import { OutboxService } from '../outbox.service';
import { AuditService } from '@server/modules/shared/audit.service';
import { TaskService } from '@server/modules/task/task.service';
import { SolverService } from '../solver.service';
import {
  person as seedPerson,
  task as seedTask,
  device as seedDevice,
  buildSnapshot,
  defaultPolicy,
  baseSolveOpts,
  makeSolver,
} from './scheduler-test-helpers';
import { makeFakeDb, testOrgContext } from './dispatch-test-harness';

describe('智能调度执行闭环 - 集成链路', () => {
  it('task → run → shadow → approve → reserve → dispatch → 状态/事件/outbox', async () => {
    // 1) 求解：生成 shadow plan。
    const { solver } = makeSolver();
    const snapshot = buildSnapshot({
      persons: [seedPerson({ id: 'p1' })],
      tasks: [seedTask({ id: 'TASK-1' })],
      devices: [seedDevice({ id: 'd1' })],
    });
    const shadowPlan = await solver.solve(snapshot, [], {
      ...baseSolveOpts,
      planId: 'PLAN-1',
      policy: defaultPolicy(),
    });
    expect(shadowPlan.status).toBe('shadow');
    expect(shadowPlan.assignments).toHaveLength(1);
    expect(shadowPlan.assignments[0].taskId).toBe('TASK-1');

    // 2) 共享状态化 DB：任务已就绪待下发。
    const { db, state } = makeFakeDb({
      tasks: [{ id: 'TASK-1', status: 'pending_dispatch', version: 1 }],
    });
    const ctx = testOrgContext();

    const requestDatabaseContext = {
      runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => {
        await cb();
      }),
    };
    const worldState = {
      assertFreshForApprove: jest.fn().mockResolvedValue(undefined),
      buildSnapshot: jest.fn().mockResolvedValue(snapshot),
      getCurrentWorldState: jest.fn().mockResolvedValue({
        safetyBlockedPersonIds: [],
        safetyBlockedDeviceIds: [],
      }),
    };
    const auditService = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const reservationService = {
      reserve: jest.fn().mockResolvedValue([
        { reservationId: 'RSV-1', resourceType: 'person', resourceId: 'p1', startMs: 0, endMs: 1000 },
      ]),
    };
    const outboxService = {
      enqueue: jest.fn().mockResolvedValue({
        id: 'evt-outbox',
        eventType: 'assignment.dispatched',
        entityId: 'ASG-1',
        payload: {},
        status: 'pending',
        sequence: 1,
        createdAt: new Date().toISOString(),
      }),
    };
    const taskService = { transitionTaskState: jest.fn().mockResolvedValue(undefined) };

    const dispatchCoordinator = new DispatchCoordinatorService(
      db,
      requestDatabaseContext as unknown as RequestDatabaseContext,
      worldState as unknown as WorldStateSnapshotService,
      reservationService as unknown as ResourceReservationService,
      outboxService as unknown as OutboxService,
      auditService as unknown as AuditService,
      taskService as unknown as TaskService,
      { recordBaseline: jest.fn().mockResolvedValue(undefined) } as never,
      { getConfig: jest.fn().mockResolvedValue({ defaultTaskDurationMs: 1_800_000 }) } as never,
      // §5.4：ADVISORY 模式路线阻断判定（默认 route_graph 不阻断）。
      {
        estimate: jest.fn().mockResolvedValue({
          routeId: 'R', distanceMeters: 10, etaSeconds: 10, riskLevel: null,
          feasible: true, source: 'route_graph', riskCost: 0, congestionCost: 0,
          graphVersion: null, calculatedAt: new Date().toISOString(),
          fallbackReason: null, dataQuality: 'FRESH',
        }),
      } as never,
    );

    const planService = new PlanService(
      db,
      requestDatabaseContext as unknown as RequestDatabaseContext,
      auditService as unknown as AuditService,
      { solve: jest.fn(), solveVariants: jest.fn() } as unknown as SolverService,
      worldState as unknown as WorldStateSnapshotService,
      dispatchCoordinator,
      { getActivePolicy: jest.fn(), getPolicy: jest.fn(), getConfig: jest.fn(), getConfigByVersion: jest.fn() } as never,
      { recordAcceptance: jest.fn().mockResolvedValue(undefined), recordBaseline: jest.fn() } as never,
      { loadForPlan: jest.fn(), hashConstraints: jest.fn() } as never,
      outboxService as unknown as OutboxService,
      { handleTrigger: jest.fn() } as never,
    );

    // 3) 持久化 shadow plan。
    await planService.persistPlan(shadowPlan, ctx);
    expect(state.plans.get('PLAN-1')?.status).toBe('shadow');

    // 4) 审批（快照新鲜时成功）。
    // B5 审批独立性：审批人必须不同于生成人（u1 生成 → u2 审批）——
    // 同人审批会被 SELF_APPROVAL_FORBIDDEN hard guard 拒绝（治理后的预期行为）。
    await planService.approvePlan(
      'PLAN-1',
      { version: shadowPlan.version, snapshotVersion: shadowPlan.snapshotVersion },
      { ...ctx, userId: 'u2' },
    );
    expect(state.plans.get('PLAN-1')?.status).toBe('approved');
    expect(state.assignments.every((a) => a.status === 'approved')).toBe(true);

    // 5) 下发（事务化：预占 → 任务推进 → 事件 → outbox）。
    const dispatched = await planService.dispatchPlan('PLAN-1', ctx);

    // plan 状态 dispatched。
    expect(dispatched.status).toBe('dispatched');
    expect(state.plans.get('PLAN-1')?.status).toBe('dispatched');

    // assignment 状态 dispatched。
    expect(state.assignments.every((a) => a.status === 'dispatched')).toBe(true);

    // production task 状态被推进（assignee/device 被写入）。
    const dbTask = state.tasks.get('TASK-1')!;
    expect(dbTask.assigneeId).toBe('p1');
    expect(dbTask.deviceId).toBe('d1');
    expect(taskService.transitionTaskState).toHaveBeenCalledWith(
      'TASK-1',
      'dispatch',
      ctx,
    );

    // 资源预占被调用（person + device）。
    expect(reservationService.reserve).toHaveBeenCalled();

    // assignment event 写入。
    expect(state.events.length).toBeGreaterThan(0);
    expect(state.events[0].toStatus).toBe('dispatched');
    expect(state.events[0].fromStatus).toBe('approved');

    // outbox 事件生成（assignment + plan）。
    const eventTypes = outboxService.enqueue.mock.calls.map((c) => c[0]);
    expect(eventTypes).toContain('assignment.dispatched');
    expect(eventTypes).toContain('plan.dispatched');

    // 读回世界状态反映新状态（方案/分配均已 dispatched，任务已绑定资源）。
    const readBack = await planService.getPlan('PLAN-1');
    expect(readBack.status).toBe('dispatched');
    expect(readBack.assignments[0].status).toBe('dispatched');

    // NO-13k / ADR-060：派工预占决策同事务追加进方案决策台账（kind #4）。
    const planRow = state.plans.get('PLAN-1') as Record<string, unknown>;
    const decisionRecords = Array.isArray(planRow?.decisionRecordsJson)
      ? (planRow.decisionRecordsJson as Array<Record<string, unknown>>)
      : [];
    const reservationRecords = decisionRecords.filter(
      (r) => r.kind === 'resource_reservation',
    );
    expect(reservationRecords.length).toBeGreaterThanOrEqual(1);
    const first = reservationRecords[0];
    expect(first.status).toBe('executed');
    expect(first.decisionAuthority).toBe('rule_based');
    expect(String(first.decisionId)).toContain(':reservation:');
    expect(String(first.decisionId)).toContain('RSV-1');
    expect(first.subject).toBe('resource:person:p1');
    expect(validateDecision(first)).toEqual([]);
    // NO-13l / ADR-061：派工决策同事务追加进方案决策台账（kind #5）。
    const dispatchRecords = decisionRecords.filter((r) => r.kind === 'dispatch');
    expect(dispatchRecords).toHaveLength(1);
    expect(dispatchRecords[0].status).toBe('executed');
    expect(dispatchRecords[0].decisionAuthority).toBe('policy');
    expect(dispatchRecords[0].decisionId).toBe('decision:PLAN-1:dispatch');
    expect(dispatchRecords[0].subject).toBe('plan:PLAN-1');
    expect((dispatchRecords[0].selected as Record<string, unknown>).reason).toEqual(['dispatched:1']);
    expect(validateDecision(dispatchRecords[0])).toEqual([]);
    // getPlan 读回自动携带（决策历史单一事实源）。
    expect(readBack.decisionRecords?.some((r) => r.kind === 'resource_reservation')).toBe(true);
    expect(readBack.decisionRecords?.some((r) => r.kind === 'dispatch')).toBe(true);
  });

  it('审批时快照过期 → 抛 PLAN_STALE，方案状态不变', async () => {
    const { db, state } = makeFakeDb({
      plans: [
        {
          planId: 'PLAN-STALE',
          planName: 'p',
          strategy: 'scheduling_v2',
          status: 'shadow',
          version: 1,
          snapshotVersion: 'WS-OLD',
        },
      ],
      assignments: [],
      tasks: [],
    });
    const requestDatabaseContext = {
      runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => {
        await cb();
      }),
    };
    const worldState = {
      assertFreshForApprove: jest.fn().mockRejectedValue(new Error('PLAN_STALE')),
      buildSnapshot: jest.fn(),
    };
    const auditService = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const planService = new PlanService(
      db,
      requestDatabaseContext as unknown as RequestDatabaseContext,
      auditService as unknown as AuditService,
      { solve: jest.fn(), solveVariants: jest.fn() } as unknown as SolverService,
      worldState as unknown as WorldStateSnapshotService,
      { dispatch: jest.fn() } as unknown as DispatchCoordinatorService,
      { getActivePolicy: jest.fn(), getPolicy: jest.fn(), getConfig: jest.fn(), getConfigByVersion: jest.fn() } as never,
      { recordAcceptance: jest.fn().mockResolvedValue(undefined), recordBaseline: jest.fn() } as never,
      { loadForPlan: jest.fn(), hashConstraints: jest.fn() } as never,
      { enqueue: jest.fn().mockResolvedValue({ id: 'evt', eventType: 'stale_plan', entityId: 'PLAN-STALE', payload: {}, status: 'pending', sequence: 1, createdAt: new Date().toISOString() }) } as unknown as OutboxService,
      { handleTrigger: jest.fn() } as never,
    );

    await expect(
      planService.approvePlan(
        'PLAN-STALE',
        { version: 1, snapshotVersion: 'WS-OLD' },
        testOrgContext(),
      ),
    ).rejects.toThrow('PLAN_STALE');
    expect(state.plans.get('PLAN-STALE')?.status).toBe('shadow');
  });

  it('T04/P1-6: stale approve → outbox stale_plan 事件 + scoped replan（cause=PLAN_STALE）', async () => {
    const { db, state } = makeFakeDb({
      plans: [
        {
          planId: 'PLAN-STALE-2',
          planName: 'p',
          strategy: 'scheduling_v2',
          status: 'shadow',
          version: 1,
          snapshotVersion: 'WS-OLD',
        },
      ],
      assignments: [],
      tasks: [],
    });
    const requestDatabaseContext = {
      runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => {
        await cb();
      }),
    };
    const worldState = {
      assertFreshForApprove: jest.fn().mockRejectedValue(new Error('PLAN_STALE')),
      buildSnapshot: jest.fn(),
    };
    const auditService = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const outboxService = {
      enqueue: jest.fn().mockResolvedValue({
        id: 'evt', eventType: 'stale_plan', entityId: 'PLAN-STALE-2', payload: {},
        status: 'pending', sequence: 1, createdAt: new Date().toISOString(),
      }),
    };
    const replanCoordinator = {
      handleTrigger: jest.fn().mockResolvedValue({ run: { runId: 'RUN-X' }, plans: [], debounced: false }),
    };
    const planService = new PlanService(
      db,
      requestDatabaseContext as unknown as RequestDatabaseContext,
      auditService as unknown as AuditService,
      { solve: jest.fn(), solveVariants: jest.fn() } as unknown as SolverService,
      worldState as unknown as WorldStateSnapshotService,
      { dispatch: jest.fn() } as unknown as DispatchCoordinatorService,
      { getActivePolicy: jest.fn(), getPolicy: jest.fn(), getConfig: jest.fn(), getConfigByVersion: jest.fn() } as never,
      { recordAcceptance: jest.fn().mockResolvedValue(undefined), recordBaseline: jest.fn() } as never,
      { loadForPlan: jest.fn(), hashConstraints: jest.fn() } as never,
      outboxService as unknown as OutboxService,
      replanCoordinator as never,
    );

    await expect(
      planService.approvePlan(
        'PLAN-STALE-2',
        { version: 1, snapshotVersion: 'WS-OLD' },
        testOrgContext(),
      ),
    ).rejects.toThrow('PLAN_STALE');

    // outbox stale_plan 事件 + scoped replan（cause=PLAN_STALE）均被触发。
    const eventTypes = outboxService.enqueue.mock.calls.map((c) => c[0]);
    expect(eventTypes).toContain('stale_plan');
    expect(replanCoordinator.handleTrigger).toHaveBeenCalledWith(
      'PLAN_STALE',
      'PLAN-STALE-2',
      testOrgContext(),
    );
    // 方案状态不被改变（审批仍拒绝）。
    expect(state.plans.get('PLAN-STALE-2')?.status).toBe('shadow');
  });
});