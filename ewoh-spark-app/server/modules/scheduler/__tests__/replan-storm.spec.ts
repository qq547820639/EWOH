/* Incremental Replan V2 / M02：风暴守卫（08 §7）。
 *
 * 覆盖：同 org 连续触发被 minimumReplanIntervalMs/maximumReplansPerWindow 抑制；
 * 抑制计数上报（内存 getSuppressedCount）；不同 org 互不影响（租户隔离）；
 * conflict batch 一次求解处理一批（solveVariants 调用次数）。
 */
/// <reference types="jest" />
import { ReplanCoordinatorService } from '../replan-coordinator.service';
import type { WorldStateSnapshot } from '@shared/api.interface';
import { buildSnapshot } from './scheduler-test-helpers';

/** 构造带可配置 replan 风暴配置的 ReplanCoordinatorService。 */
function makeReplanService(opts: {
  replan: {
    replanDebounceMs: number;
    minimumReplanIntervalMs: number;
    maximumReplansPerWindow: number;
    conflictAggregationWindowMs: number;
  };
  evaluate?: jest.Mock;
  outbox?: { enqueue: jest.Mock };
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
    buildSnapshot: jest
      .fn()
      .mockResolvedValue(buildSnapshot({ tasks: [] })),
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
        metrics: {},
        baselineDelta: {},
        violations: [],
        createdAt: new Date().toISOString(),
      },
    ]),
  };
  const planService = { persistPlan: jest.fn().mockResolvedValue(undefined) };
  const policyService = {
    getConfig: jest.fn().mockResolvedValue({
      configVersion: 1,
      triggerCooldownMs: 1,
      priority: {},
      replan: opts.replan,
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
    undefined,
    undefined,
    opts.outbox as never,
  );
  return { svc, triggerService, solverService };
}

/** 缩短窗口以便快速连续触发（避免真实 sleep）。
 *  minimumReplanIntervalMs 用大值（60s）：抑制判定需同时满足「距上次 < minInterval」
 *  与「窗口已满」；真实计时下 5ms 极易被整机负载抖动突破导致 flake，
 *  而窗口规则（max=2）在 60s 内连续调用是确定性的。 */
const SHORT_CONFIG = {
  replanDebounceMs: 0,
  minimumReplanIntervalMs: 60_000,
  maximumReplansPerWindow: 2,
  conflictAggregationWindowMs: 60_000,
};

describe('M02 风暴守卫（replan-storm）', () => {
  it('同 org 窗口内超过 maximumReplansPerWindow 被抑制，计数上报', async () => {
    const snapshot: WorldStateSnapshot = buildSnapshot({ tasks: [] });
    const { svc, solverService } = makeReplanService({
      replan: SHORT_CONFIG,
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
    });
    const ctx = { userId: 'u1', primaryOrgId: 'org1' };

    // 前 2 次允许（窗口=2）。
    const r1 = await svc.handleTrigger('DEVICE_OFFLINE', 'd1', ctx);
    const r2 = await svc.handleTrigger('DEVICE_OFFLINE', 'd1', ctx);
    expect(r1.suppressed).toBeFalsy();
    expect(r2.suppressed).toBeFalsy();

    // 第 3 次（距上次 < minInterval 且窗口已满）→ 抑制，不创建 run、不求解。
    const r3 = await svc.handleTrigger('DEVICE_OFFLINE', 'd1', ctx);
    expect(r3.suppressed).toBe(true);
    expect(r3.run).toBeNull();
    expect(r3.plans).toEqual([]);
    expect(solverService.solveVariants).toHaveBeenCalledTimes(2);
    expect(svc.getSuppressedCount('org1')).toBe(1);
  });

  it('不同 org 互不影响（租户隔离）', async () => {
    const { svc, solverService } = makeReplanService({
      replan: SHORT_CONFIG,
    });
    const ctxA = { userId: 'uA', primaryOrgId: 'orgA' };
    const ctxB = { userId: 'uB', primaryOrgId: 'orgB' };

    // orgA 连续触发打满窗口。
    await svc.handleTrigger('DEVICE_OFFLINE', 'd1', ctxA);
    await svc.handleTrigger('DEVICE_OFFLINE', 'd1', ctxA);
    const suppressedA = await svc.handleTrigger('DEVICE_OFFLINE', 'd1', ctxA);
    expect(suppressedA.suppressed).toBe(true);

    // orgB 不受影响（第一次允许）。
    const rB = await svc.handleTrigger('DEVICE_OFFLINE', 'd1', ctxB);
    expect(rB.suppressed).toBeFalsy();
    expect(svc.getSuppressedCount('orgB')).toBe(0);
    expect(svc.getSuppressedCount('orgA')).toBe(1);
    // 求解次数：orgA 2 次 + orgB 1 次 = 3。
    expect(solverService.solveVariants).toHaveBeenCalledTimes(3);
  });

  it('M05-FIX：抑制时 outbox 发射 replan.suppressed（SSE 契约）', async () => {
    const enqueue = jest.fn().mockResolvedValue({ eventId: 'EVT-1' });
    const { svc } = makeReplanService({
      replan: SHORT_CONFIG,
      outbox: { enqueue },
    });
    const ctx = { userId: 'u1', primaryOrgId: 'org1' };

    // 前 2 次允许（窗口=2），第 3 次抑制。
    await svc.handleTrigger('DEVICE_OFFLINE', 'd1', ctx);
    await svc.handleTrigger('DEVICE_OFFLINE', 'd1', ctx);
    const r3 = await svc.handleTrigger('DEVICE_OFFLINE', 'd1', ctx);
    expect(r3.suppressed).toBe(true);

    expect(enqueue).toHaveBeenCalledWith(
      'replan.suppressed',
      expect.any(String),
      expect.objectContaining({
        triggerType: 'DEVICE_OFFLINE',
        triggerEntityId: 'd1',
        reason: 'storm_guard_suppressed',
        suppressedAt: expect.any(String),
        suppressedCount: 1,
      }),
      'org1',
      undefined,
      expect.objectContaining({ entityType: 'replan' }),
    );
  });

  it('MANUAL 触发不被风暴守卫抑制（人工重排始终放行）', async () => {
    const { svc, solverService } = makeReplanService({
      replan: { ...SHORT_CONFIG, maximumReplansPerWindow: 1 },
    });
    const ctx = { userId: 'u1', primaryOrgId: 'org1' };

    await svc.handleTrigger('MANUAL', null, ctx);
    await svc.handleTrigger('MANUAL', null, ctx);
    const r3 = await svc.handleTrigger('MANUAL', null, ctx);
    expect(r3.suppressed).toBeFalsy();
    expect(solverService.solveVariants).toHaveBeenCalledTimes(3);
  });

  it('conflict batch 一次 solveVariants 处理一批（dispatchStateTriggers 聚合）', async () => {
    const snapshot = buildSnapshot({
      tasks: [],
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
        {
          reservationId: 'RSV-3',
          resourceType: 'device',
          resourceId: 'd1',
          startMs: 0,
          endMs: 1000,
        },
        {
          reservationId: 'RSV-4',
          resourceType: 'device',
          resourceId: 'd1',
          startMs: 500,
          endMs: 1500,
        },
      ],
    });
    const { svc, solverService } = makeReplanService({
      replan: SHORT_CONFIG,
    });

    const dispatched = await svc.dispatchStateTriggers(snapshot, {
      userId: 'u1',
      primaryOrgId: 'org1',
    });

    // 两个冲突资源（p1 + d1）聚合为一次 batch → 一次求解。
    expect(solverService.solveVariants).toHaveBeenCalledTimes(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].triggerType).toBe('RESERVATION_CONFLICT');
  });
});
