/* Incremental Replan V2 / M02：ReplanCoordinatorService.analyzeImpactV2 + handleTrigger 子图（08 §1/§2）。
 *
 * 覆盖：analyzeImpactV2 形状（affected/movable/frozen 划分）、核心不变量
 * （无关任务不入 solver 子图）、frozen 保持、风暴守卫抑制语义（handleConflictBatch）。
 */
/// <reference types="jest" />
import { ReplanCoordinatorService } from '../replan-coordinator.service';
import type { ReplanImpact, WorldStateSnapshot } from '@shared/api.interface';
import {
  person as seedPerson,
  task as seedTask,
  device as seedDevice,
  buildSnapshot,
} from './scheduler-test-helpers';

function makeReplanService(opts: {
  snapshot: WorldStateSnapshot;
  evaluate?: jest.Mock;
  policyService?: unknown;
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
        triggerType: 'RESERVATION_CONFLICT',
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
        trigger: { type: 'RESERVATION_CONFLICT', entityId: null },
        snapshotVersion: 'WS-TEST-0001',
        policyVersion: 1,
        solverVersion: 'heuristic-v2',
        horizonMinutes: 480,
        assignments: [],
        metrics: {},
        baselineDelta: {},
        violations: [],
        createdAt: new Date().toISOString(),
      },
    ]),
  };
  const planService = { persistPlan: jest.fn().mockResolvedValue(undefined) };
  // 默认 policyService 提供 getConfig（replan 配置缺省）；测试可覆盖。
  const policyService =
    opts.policyService ??
    {
      getConfig: jest.fn().mockResolvedValue({
        configVersion: 1,
        triggerCooldownMs: 30_000,
        priority: {},
        replan: {
          replanDebounceMs: 5_000,
          minimumReplanIntervalMs: 30_000,
          maximumReplansPerWindow: 12,
          conflictAggregationWindowMs: 60_000,
          maxPropagationDepth: 3,
          maxAffectedTasks: 200,
        },
      }),
    };

  const svc = new ReplanCoordinatorService(
    db as never,
    requestDatabaseContext as never,
    triggerService as never,
    worldStateSnapshotService as never,
    solverService as never,
    planService as never,
    policyService as never,
  );
  return { svc, triggerService, solverService, planService };
}

describe('M02 ReplanCoordinatorService.analyzeImpactV2', () => {
  it('返回 ReplanImpact 形状：affected/movable/frozen 划分正确', async () => {
    const snapshot = buildSnapshot({
      persons: [seedPerson({ id: 'p1' }), seedPerson({ id: 'p2' })],
      devices: [seedDevice({ id: 'd1' })],
      tasks: [
        { ...seedTask({ id: 't-affected' }), assigneeId: 'p1', deviceId: 'd1' },
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
    const { svc } = makeReplanService({ snapshot });

    const impact: ReplanImpact = await svc.analyzeImpactV2(
      'DEVICE_OFFLINE',
      ['d1'],
      { userId: 'u1', primaryOrgId: 'org1' },
    );

    expect(impact.triggerType).toBe('DEVICE_OFFLINE');
    expect(impact.affectedTaskIds).toContain('t-affected');
    expect(impact.affectedTaskIds).not.toContain('t-other');
    // 冻结：executing 任务在 frozenAssignmentIds 而非 movable。
    expect(impact.frozenAssignmentIds).toContain('t-exec');
    expect(impact.movableAssignmentIds).toContain('t-affected');
    expect(impact.movableAssignmentIds).not.toContain('t-exec');
    expect(impact.snapshotVersion).toBe('WS-TEST-0001');
  });

  it('核心不变量：无关任务不进入 handleTrigger 求解子图', async () => {
    const snapshot = buildSnapshot({
      persons: [seedPerson({ id: 'p1' }), seedPerson({ id: 'p2' })],
      devices: [seedDevice({ id: 'd1' })],
      tasks: [
        { ...seedTask({ id: 't-affected' }), deviceId: 'd1' },
        { ...seedTask({ id: 't-other' }), assigneeId: 'p2', zoneId: 'Z-9' },
      ],
    });
    const { svc, solverService } = makeReplanService({ snapshot });

    await svc.handleTrigger('DEVICE_OFFLINE', 'd1', {
      userId: 'u1',
      primaryOrgId: 'org1',
    });

    expect(solverService.solveVariants).toHaveBeenCalledTimes(1);
    const [partialSnapshot] = solverService.solveVariants.mock.calls[0];
    const taskIds = (partialSnapshot as WorldStateSnapshot).tasks
      .map((t: { id: string }) => t.id)
      .sort();
    expect(taskIds).toEqual(['t-affected']);
  });

  it('frozen 任务在受影响时保留（executing/locked 不丢）', async () => {
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
    const taskIds = (partialSnapshot as WorldStateSnapshot).tasks
      .map((t: { id: string }) => t.id)
      .sort();
    expect(taskIds).toEqual(['t-exec', 't1']);
  });
});

describe('M02 handleConflictBatch（conflict batch seed）', () => {
  it('一次 solveVariants 处理一批冲突资源（solveVariants 调用次数=1）', async () => {
    const snapshot = buildSnapshot({
      persons: [seedPerson({ id: 'p1' }), seedPerson({ id: 'p2' })],
      devices: [seedDevice({ id: 'd1' }), seedDevice({ id: 'd2' })],
      tasks: [
        { ...seedTask({ id: 't1' }), assigneeId: 'p1', deviceId: 'd1' },
        { ...seedTask({ id: 't2' }), assigneeId: 'p2', deviceId: 'd2' },
      ],
    });
    const { svc, solverService } = makeReplanService({ snapshot });

    await svc.handleConflictBatch(
      ['p1', 'd1', 'p2', 'd2'],
      ['t1', 't2'],
      { userId: 'u1', primaryOrgId: 'org1' },
    );

    expect(solverService.solveVariants).toHaveBeenCalledTimes(1);
    const [partialSnapshot] = solverService.solveVariants.mock.calls[0];
    const taskIds = (partialSnapshot as WorldStateSnapshot).tasks
      .map((t: { id: string }) => t.id)
      .sort();
    expect(taskIds).toEqual(['t1', 't2']);
  });
});
