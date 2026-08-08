/* v0.7 B3：SSE 实时事件推送测试（conflict.detected / execution.deviation）
 * 覆盖：
 *   - listConflicts 发现新冲突 → enqueue conflict.detected（仅首次推送，防轮询重复）
 *   - 同冲突重复查询 → 不再推送（内存去重）
 *   - recordTaskActuals 回填 → enqueue execution.deviation（含偏差载荷）
 *   - 缺失 outboxService（未注入）→ 静默跳过不抛错
 */
/// <reference types="jest" />
import { SchedulerService } from '../scheduler.service';
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
    { deriveKpis: jest.fn(), recordActuals: jest.fn().mockResolvedValue(undefined) } as unknown as SchedulingFeedbackService,
    outbox as never,
  );
  return { svc, outbox };
}

describe('v0.7 B3: conflict.detected SSE 推送', () => {
  it('发现新冲突 → enqueue conflict.detected（含类型/严重度/消息）', async () => {
    const { svc, outbox } = makeSvc({
      state: {
        devices: [{ id: 'd1', batteryPct: 10, online: true, status: 'online', dataQuality: 'FRESH' }],
      },
    });

    await svc.listConflicts({});
    expect(outbox.enqueue).toHaveBeenCalledWith(
      'conflict.detected',
      expect.stringContaining('CFL-'),
      expect.objectContaining({ type: 'low_battery', severity: 'medium' }),
      null,
    );
  });

  it('同一冲突重复查询 → 不再重复推送（内存去重）', async () => {
    const { svc, outbox } = makeSvc({
      state: {
        devices: [{ id: 'd1', batteryPct: 10, online: true, status: 'online', dataQuality: 'FRESH' }],
      },
    });

    await svc.listConflicts({});
    const firstCalls = outbox.enqueue.mock.calls.length;
    await svc.listConflicts({});
    expect(outbox.enqueue.mock.calls.length).toBe(firstCalls);
  });

  it('无冲突 → 不推送', async () => {
    const { svc, outbox } = makeSvc({ state: {} });
    await svc.listConflicts({});
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('未注入 outboxService → 静默跳过不抛错', async () => {
    const db = makeFakeDb([]);
    const requestDatabaseContext = {
      runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => cb()),
    };
    const worldStateSnapshotService = {
      getCurrentWorldState: jest.fn().mockResolvedValue({
        worldVersion: 1,
        entityVersions: {},
        reservations: [],
        persons: [],
        tasks: [],
        devices: [{ id: 'd1', batteryPct: 10, online: true, status: 'online', dataQuality: 'FRESH' }],
        stations: [],
        backlog: [],
        events: [],
        routeStatus: [],
        forbiddenZones: [],
        lockedAssignments: [],
      } as never),
    };
    const svc = new SchedulerService(
      db,
      requestDatabaseContext as never,
      { appendAuditLog: jest.fn() } as never,
      worldStateSnapshotService as unknown as WorldStateSnapshotService,
      {} as never,
      {} as never,
      {} as unknown as PlanService,
      {} as never,
      {} as never,
      {} as never,
      { getConfig: jest.fn().mockResolvedValue({ minBatteryPct: 40 }) } as never,
      { deriveKpis: jest.fn() } as unknown as SchedulingFeedbackService,
      // 不传 outboxService（undefined）→ 应静默跳过
    );
    await expect(svc.listConflicts({})).resolves.toBeDefined();
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

    expect(outbox.enqueue).toHaveBeenCalledWith(
      'execution.deviation',
      'TASK-1',
      expect.objectContaining({
        planId: 'PLAN-1',
        assignmentId: 'ASG-1',
        taskId: 'TASK-1',
        actualStart: '2026-08-08T08:05:00.000Z',
      }),
      'org1',
    );
  });

  it('缺少匹配键 → 400 且不推送', async () => {
    const { svc, outbox } = makeSvc({});
    await expect(
      svc.recordTaskActuals({ actualStart: '2026-08-08T08:00:00Z' }),
    ).rejects.toThrow('至少提供一个匹配键');
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});
