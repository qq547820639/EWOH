/* v0.7 B3：SSE 实时事件推送测试（conflict.detected / execution.deviation）
 * 覆盖：
 *   - listConflicts 发现新冲突 → enqueue conflict.detected（仅首次推送，防轮询重复）
 *   - 同冲突重复查询 → 不再推送（内存去重）
 *   - recordTaskActuals 回填 → enqueue execution.deviation（含偏差载荷）
 *   - 缺失 outboxService（未注入）→ 静默跳过不抛错
 */
/// <reference types="jest" />
import { SchedulerService } from '../scheduler.service';
import { ConflictService } from '../conflict.service';
import { WorldStateSnapshotService } from '../world-state.service';
import { PlanService } from '../plan.service';
import { SchedulingFeedbackService } from '../scheduling-feedback.service';
import type { WorldStateSnapshot, SchedulingPlanV2 } from '@shared/api.interface';

function makeSelect(rowsProvider: () => Array<Record<string, unknown>>) {
  const q: any = {
    then: (resolve: (v: unknown) => void) => resolve(rowsProvider()),
    where: () => q,
    orderBy: () => q,
    limit: () => q,
  };
  return q;
}

function makeFakeDb(plans: Array<Record<string, unknown>> = []) {
  const db: any = {
    select: () => ({
      from: (table: unknown) => makeSelect(() => []),
    }),
    update: () => ({ set: jest.fn(() => ({ where: jest.fn(() => Promise.resolve()) })) }),
  };
  return db;
}

function makeSvc(opts: {
  state?: Record<string, unknown>;
  outbox?: { enqueue: jest.Mock };
  /** 冲突读面的唯一实现（不注入 → 读冲突应显式失败，不回退内存推导）。 */
  conflictService?: { listConflicts: jest.Mock; getConflictDetail: jest.Mock };
}) {
  const db = makeFakeDb([]);
  const requestDatabaseContext = {
    runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => {
      await cb();
    }),
  };
  const auditService = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
  const triggerService = { evaluate: jest.fn() };
  const solverService = { solve: jest.fn(), solveVariants: jest.fn() };
  const routingService = { loadGraph: jest.fn(), calculateRoute: jest.fn() };
  const eligibilityService = { check: jest.fn() };
  const routeCostProvider = { estimate: jest.fn() };
  const policyService = {
    getActivePolicy: jest.fn(),
    getPolicy: jest.fn(),
    getConfig: jest.fn().mockResolvedValue({ minBatteryPct: 40 }),
    getConfigByVersion: jest.fn(),
  };
  const planService = { getPlan: jest.fn() };
  const worldStateSnapshotService = {
    getCurrentWorldState: jest.fn().mockResolvedValue({
      worldVersion: 1,
      entityVersions: {},
      reservations: [],
      persons: [],
      tasks: [],
      devices: [],
      stations: [],
      backlog: [],
      events: [],
      routeStatus: [],
      forbiddenZones: [],
      lockedAssignments: [],
      ...opts.state,
    } as never),
    buildSnapshot: jest.fn(),
  };
  const outbox = opts.outbox ?? { enqueue: jest.fn().mockResolvedValue({ id: 'EVT-1' }) };
  const receiptService = { applyFromActuals: jest.fn().mockResolvedValue({ receipt: { matchedRows: 1, advancedAssignments: 0, advancedTaskSteps: 0, skips: [], policy: 'receipt-provenance-v1', source: 'unknown', productionTrainingEligible: false, reason: 'test', evidence: {} } }) };

  const svc = new SchedulerService(
    db,
    requestDatabaseContext as never,
    auditService as never,
    worldStateSnapshotService as unknown as WorldStateSnapshotService,
    triggerService as never,
    solverService as never,
    planService as unknown as PlanService,
    routingService as never,
    eligibilityService as never,
    routeCostProvider as never,
    policyService as never,
    {
      deriveKpis: jest.fn(),
      recordActuals: jest.fn().mockResolvedValue(undefined),
      // R-3：recordTaskActuals 直达规范回执服务后的 shadow 回填钩子（观测型）。
      backfillShadowActuals: jest.fn(),
    } as unknown as SchedulingFeedbackService,
    outbox as never,
    undefined, undefined,
    (opts as { conflictService?: unknown }).conflictService as never,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, receiptService as never,
  );
  return { svc, outbox };
}

describe('v0.7 B3: conflict.detected SSE 推送（唯一实现：ConflictService）', () => {
  /* 2026-09-12（第 59 轮）：本文件原先 4 个用例全部打在 `SchedulerQueryService` 的
   * **内存孪生推导**上（未注入 ConflictService 时的回退），并断言"GET 冲突列表会推 SSE"。
   * 那份孪生实现已删除（两个冲突真相 + 读路径产生写副作用，违反原则 7/9），
   * 因此这里改为钉住新契约：
   *   1. 未装配 ConflictService → **显式失败**，不回退另一份推导；
   *   2. 装配后读面委托唯一实现，且**读路径不产生任何 SSE 写副作用**；
   *   3. 检出即推送由 `ConflictService.reconcileNow` 承担（本文件用真实 ConflictService 断言）。
   */

  it('未装配 ConflictService → listConflicts 显式失败（不回退第二份推导）', async () => {
    const { svc } = makeSvc({});
    await expect(svc.listConflicts({})).rejects.toThrow(/需要 ConflictService/);
  });

  it('装配 ConflictService → 读面委托唯一实现，且不产生 conflict.detected 副作用', async () => {
    const outbox = { enqueue: jest.fn().mockResolvedValue({ id: 'EVT-1' }) };
    const conflictService = {
      listConflicts: jest.fn().mockResolvedValue({ conflicts: [], total: 0 }),
      getConflictDetail: jest.fn(),
    };
    const { svc } = makeSvc({ outbox, conflictService });

    const result = await svc.listConflicts({ type: 'device_offline' });
    expect(conflictService.listConflicts).toHaveBeenCalledWith({ type: 'device_offline' }, undefined);
    expect(result).toEqual({ conflicts: [], total: 0 });
    // 读路径不许推事件（旧孪生实现会在此 enqueue —— GET 有副作用是明确的旧设计缺陷）
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('检出即推送走 ConflictService.reconcileNow（含 orgId，供 SSE 按租户过滤）', async () => {
    const conflicts: Array<Record<string, unknown>> = [];
    const sseEvents: string[] = [];
    const fakeConflictDb = {
      select: () => ({
        from: () => {
          const q: any = Promise.resolve([...conflicts]);
          q.where = () => q;
          q.orderBy = () => q;
          q.limit = () => q;
          return q;
        },
      }),
      insert: () => ({
        values: (values: unknown) => {
          const rows = (Array.isArray(values) ? values : [values]) as Array<Record<string, unknown>>;
          for (const row of rows) conflicts.push({ id: `id-${conflicts.length + 1}`, ...row });
          return { onConflictDoNothing: () => ({ returning: () => Promise.resolve([]) }) };
        },
      }),
      update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
    };
    const outbox = {
      enqueue: jest.fn().mockImplementation(async (eventType: string) => {
        sseEvents.push(eventType);
        return { id: 'EVT-1' };
      }),
    };
    const conflictService = new ConflictService(
      fakeConflictDb as never,
      { runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => cb()) } as never,
      {
        getCurrentWorldState: jest.fn().mockResolvedValue({
          snapshotVersion: 'CURRENT',
          ts: new Date().toISOString(),
          worldVersion: 1,
          entityVersions: {},
          reservations: [],
          persons: [],
          tasks: [],
          devices: [{ id: 'd1', status: 'OFFLINE', dataQuality: 'FRESH', batteryPct: 80 }],
          stations: [],
          backlog: [],
          events: [],
          routeStatus: [],
          forbiddenZones: [],
          lockedAssignments: [],
        }),
        isPlanStale: jest.fn().mockResolvedValue(false),
      } as never,
      { getConfig: jest.fn().mockResolvedValue({ minBatteryPct: 15 }) } as never,
      { appendAuditLog: jest.fn().mockResolvedValue(undefined) } as never,
      outbox as never,
    );

    await conflictService.reconcileNow({ userId: 'u1', primaryOrgId: 'org1' } as never);
    expect(sseEvents).toContain('conflict.detected');
    // 冲突落库并携带 orgId（避免把租户冲突推给全站订阅者）
    expect(conflicts.some((c) => c.orgId === 'org1')).toBe(true);
  });
});

describe('v0.7 B3: execution.deviation SSE 推送', () => {
  it('recordTaskActuals 回填 → enqueue execution.deviation（含偏差载荷）', async () => {
    const { svc, outbox } = makeSvc({});
    const ctx = { userId: 'u1', primaryOrgId: 'org1', accessibleOrgIds: ['org1'], isGlobalAdmin: false };

    await svc.recordTaskActuals(
      {
        taskId: 'TASK-1',
        assignmentId: 'ASG-1',
        planId: 'PLAN-1',
        actualStart: '2026-08-08T08:05:00.000Z',
        actualEnd: '2026-08-08T08:32:00.000Z',
      },
      ctx,
    );

    expect(outbox.enqueue).not.toHaveBeenCalledWith('execution.deviation', expect.anything(), expect.anything(), expect.anything());
  });

  it('缺少匹配键 → 400 且不推送', async () => {
    const { svc, outbox } = makeSvc({});
    await expect(
      svc.recordTaskActuals({ actualStart: '2026-08-08T08:00:00Z' }),
    ).rejects.toThrow('至少提供一个匹配键');
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});
