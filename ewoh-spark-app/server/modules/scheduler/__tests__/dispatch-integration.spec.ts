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
      // 分波次派工新增协作方法：替身必须同形实现，否则波次派工路径不可测。
      assertFreshForWave: jest.fn().mockResolvedValue(undefined),
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
      // 分波次派工新增协作方法：替身必须同形实现，否则波次派工路径不可测。
      assertFreshForWave: jest.fn().mockRejectedValue(new Error('PLAN_STALE')),
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

  it('NO-62c: stale approve → outbox stale_plan 事件在**独立事务**里提交（不再假称自动重排）', async () => {
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
    // NO-62c：审批拒绝路径会在**独立事务**里写留痕（请求事务会因 409 回滚），
    // 替身必须同形实现——否则"写入被回滚"这个真实缺陷在单测里永远看不见。
    const detachedDb = { __tag: 'detached-tx' };
    const requestDatabaseContext = {
      runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => {
        await cb();
      }),
      runDetachedTransaction: jest.fn(
        async (_guc: unknown, cb: (db: unknown) => Promise<void>) => {
          await cb(detachedDb);
        },
      ),
    };
    const worldState = {
      assertFreshForApprove: jest.fn().mockRejectedValue(new Error('PLAN_STALE')),
      // 分波次派工新增协作方法：替身必须同形实现，否则波次派工路径不可测。
      assertFreshForWave: jest.fn().mockRejectedValue(new Error('PLAN_STALE')),
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

    // 1) 事件真的入了队，且**带独立事务句柄**（否则会被 409 的请求事务回滚带走）。
    const eventTypes = outboxService.enqueue.mock.calls.map((c) => c[0]);
    expect(eventTypes).toContain('stale_plan');
    expect(requestDatabaseContext.runDetachedTransaction).toHaveBeenCalled();
    const staleCall = outboxService.enqueue.mock.calls.find((c) => c[0] === 'stale_plan');
    expect((staleCall?.[5] as { executor?: unknown })?.executor).toBe(detachedDb);
    // 2) 不再假装"自动 scoped replan"：旧实现在**被中止的请求事务**里跑完整求解
    //    （实测：求解白跑 + 写入丢失 + 长时间占用连接）。补偿入口改为显式重排
    //    （POST /plans/:id/replan 或页面一键重排），由调用方在 409 之后发起。
    expect(replanCoordinator.handleTrigger).not.toHaveBeenCalled();
    // 3) 方案状态不被改变（审批仍拒绝）。
    expect(state.plans.get('PLAN-STALE-2')?.status).toBe('shadow');
  });
});

/* ── NO-36a：派工是执行边界的提交时刻（会话事实必须在事务内复查）────────────── */
describe('派工 · 外骨骼会话执行边界（NO-36a）', () => {
  const DEV_UUID = '11111111-1111-4111-8111-111111111111';
  const WEARER = '33333333-3333-4333-8333-333333333333';
  const OTHER = '44444444-4444-4444-8444-444444444444';

  function makeCoordinator(
    worldDevicesSeq: Array<Array<Record<string, unknown>>>,
    assignedPersonId: string = OTHER,
  ) {
    const { db, state } = makeFakeDb({
      plans: [
        { planId: 'PLAN-EXO', status: 'approved', snapshotVersion: 'WS-TEST', orgId: 'org1', version: 1 },
      ],
      assignments: [
        {
          assignmentId: 'ASG-EXO',
          planId: 'PLAN-EXO',
          taskId: 'TASK-EXO',
          personId: assignedPersonId,
          deviceId: DEV_UUID,
          stationId: null,
          status: 'approved',
          version: 1,
          orgId: 'org1',
        },
      ],
      tasks: [{ id: 'TASK-EXO', status: 'pending_dispatch', version: 1, orgId: 'org1' }],
    });
    let call = 0;
    const worldState = {
      assertFreshForApprove: jest.fn().mockResolvedValue(undefined),
      assertFreshForWave: jest.fn().mockResolvedValue(undefined),
      getCurrentWorldState: jest.fn(async () => {
        const devices = worldDevicesSeq[Math.min(call, worldDevicesSeq.length - 1)] ?? [];
        call += 1;
        return { safetyBlockedPersonIds: [], safetyBlockedDeviceIds: [], devices };
      }),
    };
    const svc = new DispatchCoordinatorService(
      db,
      { runInTransaction: jest.fn(async (_g: unknown, cb: () => Promise<void>) => { await cb(); }) } as unknown as RequestDatabaseContext,
      worldState as unknown as WorldStateSnapshotService,
      { reserve: jest.fn().mockResolvedValue([]), assertStationCapacityAvailable: jest.fn().mockResolvedValue(undefined) } as unknown as ResourceReservationService,
      { enqueue: jest.fn().mockResolvedValue({ id: 'evt', eventType: 'assignment.dispatched', entityId: 'ASG-EXO', payload: {}, status: 'pending', sequence: 1, createdAt: new Date().toISOString() }) } as unknown as OutboxService,
      { appendAuditLog: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
      { transitionTaskState: jest.fn().mockResolvedValue(undefined) } as unknown as TaskService,
      { recordBaseline: jest.fn().mockResolvedValue(undefined) } as never,
      { getConfig: jest.fn().mockResolvedValue({ defaultTaskDurationMs: 1_800_000 }) } as never,
      { estimate: jest.fn().mockResolvedValue({ routeId: 'R', distanceMeters: 10, etaSeconds: 10, riskLevel: null, feasible: true, source: 'route_graph', riskCost: 0, congestionCost: 0, graphVersion: null, calculatedAt: new Date().toISOString(), fallbackReason: null, dataQuality: 'FRESH' }) } as never,
    );
    return { svc, state };
  }

  const sessionDevice = {
    id: DEV_UUID,
    deviceId: 'EXO-001',
    activeExoSession: { sessionId: 'exo-session:live', personId: `person:${WEARER}`, startedAt: '2026-09-12T08:00:00.000Z' },
  };

  it('事务前预检：方案把佩戴中的设备指派给别人 → 409 EXO_SESSION_DISPATCH_CONFLICT（不落任何预占）', async () => {
    const { svc, state } = makeCoordinator([[sessionDevice]]);
    const error = await svc.dispatch('PLAN-EXO', testOrgContext()).catch((caught) => caught);
    expect(error?.getStatus?.()).toBe(409);
    expect(String(error.message)).toContain('EXO_SESSION_DISPATCH_CONFLICT');
    expect(String(error.message)).toContain('EXO-001');
    // fail-fast：方案状态、assignment 状态、预占都不动（可修正后重试）。
    expect(state.plans.get('PLAN-EXO')?.status).toBe('approved');
    expect(state.assignments[0]?.status).toBe('approved');
    expect(state.reservations).toHaveLength(0);
  });

  it('TOCTOU：预检时无会话、提交时有人戴上 → 事务内复查 409 EXO_SESSION_DISPATCH_CONFLICT_TX（无半成品）', async () => {
    // 第 1 次 getCurrentWorldState（事务前预检）无会话；第 2 次（事务内）有会话。
    const { svc, state } = makeCoordinator([[], [sessionDevice]]);
    const error = await svc.dispatch('PLAN-EXO', testOrgContext()).catch((caught) => caught);
    expect(error?.getStatus?.()).toBe(409);
    expect(String(error.message)).toContain('EXO_SESSION_DISPATCH_CONFLICT_TX');
    expect(state.plans.get('PLAN-EXO')?.status).toBe('approved');
    expect(state.assignments[0]?.status).toBe('approved');
    expect(state.reservations).toHaveLength(0);
  });

  it('佩戴者本人 + 该设备 → 不做会话阻断（人机同体可下发）', async () => {
    const { svc } = makeCoordinator([[sessionDevice]], WEARER);
    const result = await svc.dispatch('PLAN-EXO', testOrgContext());
    expect(result).toBeTruthy();
  });
});
