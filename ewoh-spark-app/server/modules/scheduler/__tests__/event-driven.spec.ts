/* Task 5 事件驱动重排闭环测试（cmd-map-scheduling-closed-loop）。
 * 覆盖：路由阻断/拥塞、资源预占冲突的触发接入 + ImpactAnalyzer 影响域裁剪
 * + 局部 scoped 重排（冻结保留）+ 冷却去抖防止冗余全局重排。
 */
/// <reference types="jest" />
import { ImpactAnalyzer } from '../impact-analyzer';
import { ReplanCoordinatorService } from '../replan-coordinator.service';
import type { WorldStateSnapshot } from '@shared/api.interface';
import {
  person as seedPerson,
  task as seedTask,
  device as seedDevice,
  buildSnapshot,
} from './scheduler-test-helpers';

/* ===== 新触发类型在 ImpactAnalyzer 中的影响域裁剪 ===== */

describe('ImpactAnalyzer 扩展触发类型（Task 5.1/5.2）', () => {
  const analyzer = new ImpactAnalyzer();

  it('ROUTE_BLOCKED：仅影响阻断边所在区域的任务，hard_conflict 且可自动重排', () => {
    const snapshot = buildSnapshot({
      tasks: [
        { ...seedTask({ id: 't-zone' }), zoneId: 'z-route' },
        { ...seedTask({ id: 't-other' }), zoneId: 'z-other' },
      ],
    });
    const result = analyzer.analyze(snapshot, {
      eventType: 'ROUTE_BLOCKED',
      entityId: 'z-route',
    });
    expect(result.affectedTaskIds).toEqual(['t-zone']);
    expect(result.affectedTaskIds).not.toContain('t-other');
    expect(result.classification).toBe('hard_conflict');
    expect(result.recommendedAction).toBe('replan_partial');
    expect(result.canAutoReplan).toBe(true);
  });

  it('ROUTE_CONGESTED：soft_deviation + replan_partial，影响域按区域裁剪', () => {
    const snapshot = buildSnapshot({
      tasks: [
        { ...seedTask({ id: 't-zone' }), zoneId: 'z-route' },
        { ...seedTask({ id: 't-other' }), zoneId: 'z-other' },
      ],
    });
    const result = analyzer.analyze(snapshot, {
      eventType: 'ROUTE_CONGESTED',
      entityId: 'z-route',
    });
    expect(result.type).toBe('ROUTE_CONGESTED');
    expect(result.affectedTaskIds).toEqual(['t-zone']);
    expect(result.classification).toBe('soft_deviation');
    expect(result.canAutoReplan).toBe(true);
  });

  it('RESERVATION_CONFLICT：scoped 到冲突资源（设备/人员）涉及的任务', () => {
    const snapshot = buildSnapshot({
      tasks: [
        { ...seedTask({ id: 't-dev' }), deviceId: 'd1' },
        { ...seedTask({ id: 't-person' }), assigneeId: 'p1' },
        { ...seedTask({ id: 't-other' }), deviceId: 'd2' },
      ],
    });
    const result = analyzer.analyze(snapshot, {
      eventType: 'RESERVATION_CONFLICT',
      entityId: 'd1',
    });
    expect(result.affectedTaskIds).toContain('t-dev');
    // 冲突资源 d1 的任务之外，p1 的任务不作为 d1 的受影响集。
    expect(result.affectedTaskIds).not.toContain('t-other');
    expect(result.classification).toBe('hard_conflict');
  });
});

/* ===== ReplanCoordinatorService：路由/预占触发接入 + 局部重排 + 去抖 ===== */

describe('ReplanCoordinatorService 事件驱动重排（Task 5.1/5.2）', () => {
  function makeReplanService(opts: {
    snapshot: WorldStateSnapshot;
    evaluate?: jest.Mock;
  }) {
    const db = {
      update: jest.fn(() => ({
        set: jest.fn(() => ({ where: jest.fn(() => Promise.resolve()) })),
      })),
    };
    const requestDatabaseContext = {
      runInTransaction: jest.fn(async (_guc: unknown, fn: () => Promise<void>) =>
        fn(),
      ),
    };
    const triggerService = {
      evaluate:
        opts.evaluate ??
        jest.fn().mockResolvedValue({
          runId: 'RUN-1',
          triggerType: 'MANUAL',
          triggerEntityId: null,
          status: 'queued',
          snapshotVersion: null,
          planIds: [],
          orgId: 'org1',
          error: null,
          createdAt: new Date().toISOString(),
        }),
    };
    const worldStateSnapshotService = {
      buildSnapshot: jest.fn().mockResolvedValue(opts.snapshot),
    };
    const solverService = {
      solveVariants: jest.fn().mockResolvedValue([
        {
          planId: 'RUN-1A',
          version: 1,
          status: 'shadow',
          trigger: { type: 'MANUAL', entityId: null },
          snapshotVersion: 'WS-TEST-0001',
          policyVersion: 1,
          solverVersion: 'heuristic-v2',
          horizonMinutes: 480,
          assignments: [],
          metrics: {
            lateMinutes: 0,
            walkingMeters: 0,
            stationWaitMinutes: 0,
            maxWorkload: 0,
            changeCost: 0,
          },
          baselineDelta: {},
          violations: [],
          createdAt: new Date().toISOString(),
        },
      ]),
    };
    const planService = { persistPlan: jest.fn().mockResolvedValue(undefined) };

    const svc = new ReplanCoordinatorService(
      db as never,
      requestDatabaseContext as never,
      triggerService as never,
      worldStateSnapshotService as never,
      solverService as never,
      planService as never,
      {} as never,
    );
    return { svc, triggerService, solverService, planService };
  }

  it('路由阻断边 → 派发 ROUTE_BLOCKED，走局部重排', async () => {
    const snapshot = buildSnapshot({
      routeStatus: [{ edgeId: 'edge-x', status: 'blocked', riskLevel: null }],
    });
    const { svc, triggerService } = makeReplanService({ snapshot });

    const dispatched = await svc.dispatchStateTriggers(snapshot, {
      userId: 'u1',
      primaryOrgId: 'org1',
    });

    expect(triggerService.evaluate).toHaveBeenCalledWith(
      'ROUTE_BLOCKED',
      'edge-x',
      expect.anything(),
    );
    expect(dispatched).toEqual([
      { triggerType: 'ROUTE_BLOCKED', entityId: 'edge-x' },
    ]);
  });

  it('路由拥塞边 → 派发 ROUTE_CONGESTED', async () => {
    const snapshot = buildSnapshot({
      routeStatus: [{ edgeId: 'edge-y', status: 'congested', riskLevel: null }],
    });
    const { svc, triggerService } = makeReplanService({ snapshot });

    const dispatched = await svc.dispatchStateTriggers(snapshot, {
      userId: 'u1',
      primaryOrgId: 'org1',
    });

    expect(triggerService.evaluate).toHaveBeenCalledWith(
      'ROUTE_CONGESTED',
      'edge-y',
      expect.anything(),
    );
    expect(dispatched).toEqual([
      { triggerType: 'ROUTE_CONGESTED', entityId: 'edge-y' },
    ]);
  });

  it('资源预占冲突（同一资源时间窗重叠）→ 派发 RESERVATION_CONFLICT scoped 重排', async () => {
    const snapshot = buildSnapshot({
      reservations: [
        {
          reservationId: 'RSV-1',
          resourceType: 'person',
          resourceId: 'p1',
          startMs: 0,
          endMs: 1000,
        },
        {
          reservationId: 'RSV-2',
          resourceType: 'person',
          resourceId: 'p1',
          startMs: 500,
          endMs: 1500,
        },
      ],
    });
    const { svc, triggerService } = makeReplanService({ snapshot });

    const dispatched = await svc.dispatchStateTriggers(snapshot, {
      userId: 'u1',
      primaryOrgId: 'org1',
    });

    expect(triggerService.evaluate).toHaveBeenCalledWith(
      'RESERVATION_CONFLICT',
      'p1',
      expect.anything(),
    );
    expect(dispatched).toEqual([
      { triggerType: 'RESERVATION_CONFLICT', entityId: 'p1' },
    ]);
  });

  it('PERSON_UNAVAILABLE → scoped 重排该人员任务，无关与冻结任务不 churn', async () => {
    const snapshot = buildSnapshot({
      persons: [seedPerson({ id: 'p1' }), seedPerson({ id: 'p2' })],
      tasks: [
        { ...seedTask({ id: 't-affected' }), assigneeId: 'p1' },
        { ...seedTask({ id: 't-other' }), assigneeId: 'p2' },
        {
          ...seedTask({ id: 't-exec', status: 'executing' }),
          assigneeId: 'p1',
        },
      ],
      lockedAssignments: [
        { taskId: 't-exec', personId: 'p1', deviceId: null, stationId: null },
      ],
    });
    const { svc, solverService } = makeReplanService({ snapshot });

    await svc.handleTrigger('PERSON_UNAVAILABLE', 'p1', {
      userId: 'u1',
      primaryOrgId: 'org1',
    });

    expect(solverService.solveVariants).toHaveBeenCalledTimes(1);
    const [partialSnapshot] = solverService.solveVariants.mock.calls[0];
    const taskIds = (partialSnapshot as WorldStateSnapshot).tasks
      .map((t: { id: string }) => t.id)
      .sort();
    // 只重排受影响(t-affected) ∪ 冻结(t-exec)；无关任务 t-other 不进子图。
    expect(taskIds).toEqual(['t-affected', 't-exec']);
  });

  it('冷却去抖：evaluate 返回 null 时合并事件，不触发求解器（防冗余全局重排）', async () => {
    const snapshot = buildSnapshot({
      tasks: [{ ...seedTask({ id: 't1' }), deviceId: 'd1' }],
    });
    const evaluate = jest.fn().mockResolvedValue(null); // 冷却窗口内 → 去抖
    const { svc, solverService } = makeReplanService({ snapshot, evaluate });

    const result = await svc.handleTrigger('DEVICE_OFFLINE', 'd1', {
      userId: 'u1',
      primaryOrgId: 'org1',
    });

    expect(result.run).toBeNull();
    expect(result.debounced).toBe(true);
    expect(result.plans).toEqual([]);
    expect(solverService.solveVariants).not.toHaveBeenCalled();
  });

  it('冻结与受影响任务传入求解器，作为重排子图（冻结保留）', async () => {
    const snapshot = buildSnapshot({
      persons: [seedPerson({ id: 'p1' })],
      devices: [seedDevice({ id: 'd1' })],
      tasks: [
        { ...seedTask({ id: 't1' }), deviceId: 'd1' },
        {
          ...seedTask({ id: 't-exec', status: 'executing' }),
          assigneeId: 'p1',
          deviceId: 'd1',
        },
      ],
      lockedAssignments: [
        { taskId: 't-exec', personId: 'p1', deviceId: null, stationId: null },
      ],
    });
    const { svc, solverService } = makeReplanService({ snapshot });

    await svc.handleTrigger('DEVICE_OFFLINE', 'd1', {
      userId: 'u1',
      primaryOrgId: 'org1',
    });

    const [partialSnapshot] = solverService.solveVariants.mock.calls[0];
    const tExec = (partialSnapshot as WorldStateSnapshot).tasks.find(
      (t: { id: string }) => t.id === 't-exec',
    );
    expect(tExec).toBeDefined();
    const taskIds = (partialSnapshot as WorldStateSnapshot).tasks
      .map((t: { id: string }) => t.id)
      .sort();
    expect(taskIds).toEqual(['t-exec', 't1']);
  });
});