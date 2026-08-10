/* Task B / P0：scheduler_partial_replan_affected 指标来源统一。
 *
 * 背景：affectedTaskCount 此前恒返回 snapshot.tasks.length 并丢弃 opts，导致局部重排
 * 指标被 partial snapshot 的冻结任务数膨胀。真实影响集为 ReplanImpact.affectedTaskIds
 * （impact-propagation 产物）。本套测试验证：
 *   (a) 1 个受影响任务 → 指标 = 1；
 *   (b) N 个受影响（partial snapshot 含冻结任务 > 受影响数）→ 指标 = 受影响数（不膨胀）；
 *   (c) 全量重排（affectedTaskIds 缺省）→ 指标 = 快照任务数（保持既有语义）；
 *   (d) MANUAL 触发不记录该指标（既有语义）；
 *   (e) replan-coordinator 路径：handleTrigger 局部重排透传真实 affectedTaskIds
 *       （冻结任务保留在求解子图但不在受影响集，指标不被膨胀）。
 */
/// <reference types="jest" />
import {
  person as seedPerson,
  task as seedTask,
  device as seedDevice,
  buildSnapshot,
  defaultPolicy,
  defaultConfig,
  baseSolveOpts,
  makeSolver,
} from './scheduler-test-helpers';
import { ReplanCoordinatorService } from '../replan-coordinator.service';
import type { OrgContext } from '../../shared/org-context.interceptor';

describe('scheduler_partial_replan_affected 指标来源统一（Task B / P0）', () => {
  beforeEach(() => {
    delete process.env.EWOH_SOLVER_ACTIVATION;
    delete process.env.EWOH_SOLVER_PRODUCTION_ENABLED;
  });

  const snapshot3 = buildSnapshot({
    persons: [seedPerson({ id: 'p1' })],
    tasks: [
      seedTask({ id: 't1' }),
      seedTask({ id: 't2' }),
      seedTask({ id: 't3' }),
    ],
    devices: [seedDevice({ id: 'd1' })],
  });

  /** 通过真实 SolverService.solve 路径执行（注入 metrics mock），返回 metricsService 供断言。 */
  async function solveWith(
    snapshot: typeof snapshot3,
    affectedTaskIds?: string[],
    triggerType = 'DEVICE_OFFLINE',
  ) {
    const { solver, metricsService } = makeSolver();
    await solver.solve(snapshot, [], {
      ...baseSolveOpts,
      triggerType,
      affectedTaskIds,
      policy: defaultPolicy(),
    });
    return metricsService;
  }

  it('(a) 1 个受影响任务 → 指标 = 1（affectedTaskIds 优先于快照任务数）', async () => {
    const metrics = await solveWith(snapshot3, ['t1']);
    expect(metrics.recordPartialReplanAffected).toHaveBeenCalledWith(1);
  });

  it('(b) N 个受影响（partial snapshot 含冻结任务 > 受影响数）→ 指标 = 受影响数（不随快照膨胀）', async () => {
    // partial snapshot 共 5 个任务（2 受影响 + 3 冻结/无关），指标必须 = 2。
    const partialSnapshot = buildSnapshot({
      persons: [seedPerson({ id: 'p1' })],
      tasks: [
        seedTask({ id: 't1' }),
        seedTask({ id: 't2' }),
        seedTask({ id: 't3' }),
        seedTask({ id: 't4' }),
        seedTask({ id: 't5' }),
      ],
      devices: [seedDevice({ id: 'd1' })],
    });
    const metrics = await solveWith(partialSnapshot, ['t1', 't2']);
    expect(metrics.recordPartialReplanAffected).toHaveBeenCalledWith(2);
    // 快照任务数 5 ≠ 指标 2：证明取的是真实影响集而非 snapshot.tasks.length。
    expect(partialSnapshot.tasks.length).toBe(5);
  });

  it('(c) 全量重排（affectedTaskIds 缺省）→ 指标 = 快照任务数（保持既有语义）', async () => {
    const metrics = await solveWith(snapshot3, undefined);
    expect(metrics.recordPartialReplanAffected).toHaveBeenCalledWith(3);
  });

  it('(d) MANUAL 触发不记录 partial replan 指标（既有语义）', async () => {
    const metrics = await solveWith(snapshot3, ['t1'], 'MANUAL');
    expect(metrics.recordPartialReplanAffected).not.toHaveBeenCalled();
  });

  it('(e) replan-coordinator 路径：handleTrigger 局部重排透传真实 affectedTaskIds（冻结任务不膨胀指标）', async () => {
    // t1/t2 属于 d1（受影响）；t4 executing（冻结：保留在求解子图但不在受影响集）。
    const snapshot = buildSnapshot({
      persons: [seedPerson({ id: 'p1' }), seedPerson({ id: 'p2' })],
      tasks: [
        { ...seedTask({ id: 't1', taskType: 'work' }), deviceId: 'd1', assigneeId: 'p1' },
        { ...seedTask({ id: 't2', taskType: 'work' }), deviceId: 'd1', assigneeId: 'p1' },
        { ...seedTask({ id: 't3', taskType: 'work' }), deviceId: 'd2', assigneeId: 'p2' },
        {
          ...seedTask({ id: 't4', taskType: 'work' }),
          deviceId: 'd2',
          assigneeId: 'p2',
          status: 'executing',
        },
      ],
      devices: [seedDevice({ id: 'd1' }), seedDevice({ id: 'd2' })],
    });
    const { solver, metricsService } = makeSolver();
    const db = {
      update: jest.fn(() => ({
        set: jest.fn(() => ({ where: jest.fn(() => Promise.resolve()) })),
      })),
    };
    const requestDatabaseContext = {
      runInTransaction: jest.fn(async (_g: unknown, fn: () => Promise<void>) => {
        await fn();
      }),
    };
    const triggerService = {
      evaluate: jest.fn().mockResolvedValue({
        runId: 'RUN-1',
        triggerType: 'DEVICE_OFFLINE',
        triggerEntityId: 'd1',
        status: 'queued',
        snapshotVersion: null,
        planIds: [],
        orgId: 'org1',
        error: null,
        createdAt: new Date().toISOString(),
      }),
    };
    const worldStateSnapshotService = {
      buildSnapshot: jest.fn().mockResolvedValue(snapshot),
    };
    const planService = { persistPlan: jest.fn().mockResolvedValue(undefined) };
    const policyService = { getConfig: jest.fn().mockResolvedValue(defaultConfig()) };
    const constraintLoaderService = { loadGlobalActive: jest.fn().mockResolvedValue([]) };
    const svc = new ReplanCoordinatorService(
      db as never,
      requestDatabaseContext as never,
      triggerService as never,
      worldStateSnapshotService as never,
      solver as never,
      planService as never,
      policyService as never,
      constraintLoaderService as never,
      undefined, // metricsService（协调器）缺省：KPI 埋点跳过，不影响断言
      undefined, // outboxService 缺省
    );
    const ctx = {
      userId: 'u1',
      primaryOrgId: 'org1',
      role: 'admin',
      accessibleOrgIds: ['org1'],
      isGlobalAdmin: false,
    } as OrgContext;

    const result = await svc.handleTrigger('DEVICE_OFFLINE', 'd1', ctx);

    // 关键触发不落入 minimum_objective_improvement 抑制；run 正常闭环。
    expect(result.suppressed).not.toBe(true);
    // 受影响 = t1,t2（d1 任务）；冻结 t4 保留在子图但不在受影响集 → 指标必须 = 2 而非 3。
    expect(metricsService.recordPartialReplanAffected).toHaveBeenCalledWith(2);
  });
});
