/* Incremental Replan V2 / M02：风暴守卫（08 §7）。
 *
 * 覆盖：同 org 连续触发被 minimumReplanIntervalMs/maximumReplansPerWindow 抑制；
 * 抑制计数上报（内存 getSuppressedCount）；不同 org 互不影响（租户隔离）；
 * conflict batch 一次求解处理一批（solveVariants 调用次数）。
 */
/// <reference types="jest" />
import { ReplanCoordinatorService } from '../replan-coordinator.service';
import type { WorldStateSnapshot } from '@shared/api.interface';
import {
  buildSnapshot, fakeRunWhereBuilder
} from './scheduler-test-helpers';

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
  /**
   * F-10：给出该参数即走 **DB 权威分支**（advisory xact lock）；
   * 缺省不提供 `execute` → 走内存降级分支（既有窗口用例依赖这一点）。
   */
  advisoryLockAcquired?: boolean;
  /** 逐次返回的加锁结果（F-10b：验证"锁忙先等再判"）。给了它就忽略 advisoryLockAcquired。 */
  advisoryLockSequence?: boolean[];
  /** DB 权威分支的「本租户最近非 MANUAL run」查询替身返回值。 */
  recentRuns?: Array<{ createdAt: Date }>;
  /** DB 权威分支的「同一触发实体最近非 MANUAL run」查询替身返回值（缺省同 recentRuns）。 */
  subjectRuns?: Array<{ createdAt: Date }>;
}) {
  const db: Record<string, unknown> = {
    update: jest.fn(() => ({
      set: jest.fn(() => ({ where: jest.fn(() => fakeRunWhereBuilder()) })),
    })),
  };
  if (opts.advisoryLockSequence) {
    db.execute = jest.fn((...args: unknown[]) =>
      Promise.resolve([{ acquired: opts.advisoryLockSequence!.shift() ?? false }]),
    );
  } else if (opts.advisoryLockAcquired !== undefined) {
    db.execute = jest
      .fn()
      .mockResolvedValue([{ acquired: opts.advisoryLockAcquired }]);
  }
  if (opts.recentRuns || opts.subjectRuns) {
    const orgRows = opts.recentRuns ?? [];
    const subjectRows = opts.subjectRuns ?? orgRows;
    // 守卫按固定顺序发两次查询：①按租户（配额）②按实体（去抖，F-10 修复后）。
    let selectCalls = 0;
    db.select = jest.fn(() => {
      const rows = selectCalls++ === 0 ? orgRows : subjectRows;
      return {
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            orderBy: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve(rows)) })),
          })),
        })),
      };
    });
  }
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
        // F-10：抑制成因入契约。此用例走内存配额分支（无 execute），
        // 因此原因必须是「窗口配额打满」而不是笼统的 storm_guard_suppressed。
        reason: 'replan_interval_window_quota',
        suppressedAt: expect.any(String),
        suppressedCount: 1,
      }),
      'org1',
      undefined,
      expect.objectContaining({ entityType: 'replan' }),
    );
  });

  /**
   * F-10（2026-09-22，S-03 偶发失败定位时实测）：同租户两条自动重排相撞时，
   * 取不到 org 级 advisory xact lock 的那一条被抑制，数据面上**只有**一条
   * outbox `replan.suppressed`。此前它的 reason 与「窗口配额打满」完全相同，
   * 于是「政策说不必重排」和「另一个重排正占着守卫锁」分不出来——
   * 而前者不该补投、后者该补投，结论相反。本例钉住原因可区分。
   */
  it('F-10：守卫锁被占用 → 抑制原因为 storm_guard_lock_busy（与政策配额可区分）', async () => {
    const enqueue = jest.fn().mockResolvedValue({ eventId: 'EVT-1' });
    const { svc, solverService } = makeReplanService({
      // 窗口故意宽松（不会因配额抑制）：本例只可能因锁忙被抑制。
      replan: { ...SHORT_CONFIG, maximumReplansPerWindow: 100 },
      outbox: { enqueue },
      advisoryLockAcquired: false,
    });
    const ctx = { userId: 'u1', primaryOrgId: 'org1' };

    const res = await svc.handleTrigger('DEVICE_OFFLINE', 'd-offline', ctx);
    expect(res.suppressed).toBe(true);
    expect(res.run).toBeNull();
    expect(solverService.solveVariants).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      'replan.suppressed',
      'd-offline',
      expect.objectContaining({ reason: 'storm_guard_lock_busy' }),
      'org1',
      undefined,
      expect.objectContaining({ entityType: 'replan' }),
    );
  });

  /** 同一条代码路径的对照：取到锁后走 DB 权威窗口判定，原因不得是「锁忙」。 */
  it('F-10 对照：取到守卫锁后按最近 run 判去抖，原因=replan_debounce_window', async () => {
    const enqueue = jest.fn().mockResolvedValue({ eventId: 'EVT-1' });
    const { svc } = makeReplanService({
      replan: { ...SHORT_CONFIG, replanDebounceMs: 5_000 },
      outbox: { enqueue },
      advisoryLockAcquired: true,
      // 本租户 1 秒前刚有一条非 MANUAL run 提交 → 去抖窗口内。
      recentRuns: [{ createdAt: new Date(Date.now() - 1_000) }],
    });
    const debug = jest.fn();
    (svc as unknown as { logger: Record<string, unknown> }).logger = {
      debug,
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const ctx = { userId: 'u1', primaryOrgId: 'org1' };

    const res = await svc.handleTrigger('DEVICE_OFFLINE', 'd-offline', ctx);
    expect(res.debounced).toBe(true);
    expect(res.suppressed).toBeFalsy();
    expect(enqueue).not.toHaveBeenCalled();
    // 这条用例同时是该守卫 **DB 权威分支**（advisory lock + 以 run 表派生状态）
    // 的第一次覆盖：此前本文件所有用例都因缺 execute 替身而走内存降级。
    expect(
      debug.mock.calls.some((c) => String(c[0]).includes('reason=replan_debounce_window')),
    ).toBe(true);
  });

  /**
   * F-10 观测性第二半：去抖（debounce）此前在数据面上**零痕迹**——
   * 不建 run、不建 trigger 行、不发 outbox、无日志。run=0 时无法与
   * 「续作丢失（RUN-01）」区分，只能靠复现。现在至少有一条带 reason 的 debug。
   */
  /**
   * F-10 修复本体（2026-09-22，由 S-03 偶发失败 + S-05 现状用例实测驱动）：
   * 去抖原来按**租户**判，于是 `TASK_UPDATED(taskX)` 刚跑完就把不相关的
   * `DEVICE_OFFLINE(deviceB)` 一起合掉——两个互不覆盖的工作项，前一次重排的快照里
   * 没有后一次故障，合并等于那条故障永远没人重排。现在去抖按实体判。
   */
  it('F-10 修复：同租户刚跑过另一个实体的重排，不合并本实体的新需求', async () => {
    const { svc, solverService, triggerService } = makeReplanService({
      replan: { ...SHORT_CONFIG, replanDebounceMs: 5_000, maximumReplansPerWindow: 100 },
      advisoryLockAcquired: true,
      recentRuns: [{ createdAt: new Date(Date.now() - 1_000) }],
      subjectRuns: [],
    });
    const ctx = { userId: 'u1', primaryOrgId: 'org1' };

    const res = await svc.handleTrigger('DEVICE_OFFLINE', 'device-B', ctx);
    expect(res.debounced).toBe(false);
    expect(res.suppressed).toBeFalsy();
    expect(triggerService.evaluate).toHaveBeenCalledWith(
      'DEVICE_OFFLINE',
      'device-B',
      ctx,
    );
    expect(solverService.solveVariants).toHaveBeenCalledTimes(1);
  });

  /** 修复的边界：去抖的保护没被放开——同一实体在窗口内仍然只重排一次。 */
/**
   * F-10b（V62）：事件路径撞锁不再直接丢需求。
   * 修复前实测：同一租户两条并发自动重排，取不到 org 守卫锁的一方被 suppressed，
   * 而 `replan.suppressed` 全仓没有消费者 ⇒ 那次故障重排永远不会发生
   * （同一现象三次复现，其中两次让 S-03 在完整 D 段里红）。
   */
  it('F-10b：事件路径锁忙时先有限等待，取得锁后照常判定并建 run', async () => {
    const { svc, triggerService } = makeReplanService({
      replan: { ...SHORT_CONFIG, replanDebounceMs: 5_000, maximumReplansPerWindow: 100 },
      advisoryLockSequence: [false, false, true],
      recentRuns: [],
    });
    const ctx = { userId: 'u1', primaryOrgId: 'org1' };

    const res = await svc.handleTrigger('DEVICE_OFFLINE', 'device-B', ctx, undefined, 500);
    expect(res.suppressed).toBeFalsy();
    expect(triggerService.evaluate).toHaveBeenCalledWith('DEVICE_OFFLINE', 'device-B', ctx);
  });

  /** 反向钉住不扩大范围：默认（HTTP 请求路径）不等待，撞锁仍立即按政策抑制。 */
  it('F-10b 边界：等待预算为 0 时不重试（不给请求路径加延迟）', async () => {
    const { svc, triggerService } = makeReplanService({
      replan: { ...SHORT_CONFIG, replanDebounceMs: 5_000, maximumReplansPerWindow: 100 },
      advisoryLockSequence: [false, true],
      recentRuns: [],
    });
    const ctx = { userId: 'u1', primaryOrgId: 'org1' };

    const res = await svc.handleTrigger('DEVICE_OFFLINE', 'device-B', ctx);
    expect(res.suppressed).toBe(true);
    expect(triggerService.evaluate).not.toHaveBeenCalled();
    const db = (svc as unknown as { db: { execute: jest.Mock } }).db;
    expect(db.execute.mock.calls.length).toBe(1);
  });

  it('F-10b：预算用尽仍是 suppressed，且原因依旧是 lock_busy（可区分于政策配额）', async () => {
    const enqueue = jest.fn().mockResolvedValue({ eventId: 'EVT-1' });
    const { svc } = makeReplanService({
      replan: { ...SHORT_CONFIG, replanDebounceMs: 5_000, maximumReplansPerWindow: 100 },
      advisoryLockSequence: [false, false, false, false, false, false, false, false],
      outbox: { enqueue },
      recentRuns: [],
    });
    const ctx = { userId: 'u1', primaryOrgId: 'org1' };

    const res = await svc.handleTrigger('DEVICE_OFFLINE', 'device-B', ctx, undefined, 250);
    expect(res.suppressed).toBe(true);
    const db = (svc as unknown as { db: { execute: jest.Mock } }).db;
    expect(db.execute.mock.calls.length).toBeGreaterThan(1);
    expect(enqueue).toHaveBeenCalledWith(
      'replan.suppressed',
      'device-B',
      expect.objectContaining({ reason: 'storm_guard_lock_busy' }),
      'org1',
      undefined,
      expect.objectContaining({ entityType: 'replan' }),
    );
  });

  it('F-10 修复边界：同一实体在去抖窗口内仍被合并', async () => {
    const { svc, solverService, triggerService } = makeReplanService({
      replan: { ...SHORT_CONFIG, replanDebounceMs: 5_000, maximumReplansPerWindow: 100 },
      advisoryLockAcquired: true,
      recentRuns: [{ createdAt: new Date(Date.now() - 1_000) }],
      subjectRuns: [{ createdAt: new Date(Date.now() - 1_000) }],
    });
    const ctx = { userId: 'u1', primaryOrgId: 'org1' };

    const res = await svc.handleTrigger('DEVICE_OFFLINE', 'device-B', ctx);
    expect(res.debounced).toBe(true);
    expect(triggerService.evaluate).not.toHaveBeenCalled();
    expect(solverService.solveVariants).not.toHaveBeenCalled();
  });

  /** 风暴保护仍在：配额按**租户**计数，与实体无关（放开去抖不等于放开负载上界）。 */
  it('F-10 修复不削弱风暴配额：跨实体打满 maximumReplansPerWindow 仍被抑制', async () => {
    const enqueue = jest.fn().mockResolvedValue({ eventId: 'EVT-1' });
    const { svc, solverService } = makeReplanService({
      replan: { ...SHORT_CONFIG, replanDebounceMs: 5_000, maximumReplansPerWindow: 2 },
      outbox: { enqueue },
      advisoryLockAcquired: true,
      recentRuns: [1, 2, 3].map((n) => ({ createdAt: new Date(Date.now() - n * 500) })),
      subjectRuns: [],
    });
    const ctx = { userId: 'u1', primaryOrgId: 'org1' };

    const res = await svc.handleTrigger('DEVICE_OFFLINE', 'device-B', ctx);
    expect(res.suppressed).toBe(true);
    expect(solverService.solveVariants).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      'replan.suppressed',
      'device-B',
      expect.objectContaining({ reason: 'replan_interval_window_quota' }),
      'org1',
      undefined,
      expect.objectContaining({ entityType: 'replan' }),
    );
  });

  it('F-10：去抖跳过必须留下可定位的 reason 日志（不再零痕迹）', async () => {
    const enqueue = jest.fn().mockResolvedValue({ eventId: 'EVT-1' });
    const { svc } = makeReplanService({
      replan: { ...SHORT_CONFIG, replanDebounceMs: 60_000 },
      outbox: { enqueue },
    });
    const debug = jest.fn();
    (svc as unknown as { logger: Record<string, unknown> }).logger = {
      debug,
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const ctx = { userId: 'u1', primaryOrgId: 'org1' };

    const first = await svc.handleTrigger('DEVICE_OFFLINE', 'd1', ctx);
    expect(first.suppressed).toBeFalsy();
    const second = await svc.handleTrigger('DEVICE_OFFLINE', 'd1', ctx);
    expect(second.debounced).toBe(true);
    expect(second.suppressed).toBeFalsy();
    // 去抖不发抑制事件（政策上它就是「已被合并」），但必须留下原因。
    expect(
      enqueue.mock.calls.some((c) => c[0] === 'replan.suppressed'),
    ).toBe(false);
    expect(
      debug.mock.calls.some((c) => String(c[0]).includes('reason=replan_debounce_window')),
    ).toBe(true);
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
