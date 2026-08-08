/* Task 2（cmd-map-scheduling-closed-loop）：GET /api/scheduler/conflicts 统一冲突列表
 * 与 GET /api/scheduler/conflicts/:id 冲突详情 的服务层单测。
 *
 * 复用现有 SchedulerService / WorldStateSnapshotService 语义，不引入并行调度器。
 * 冲突由真实世界状态 / 预占 / 活跃方案聚合推导，不虚构。
 * db 使用 in-memory fake（仅 stale plan 需要查询 ewohSchedulePlan）。
 */
/// <reference types="jest" />
import { SchedulerService } from '../scheduler.service';
import { WorldStateSnapshotService } from '../world-state.service';
import { PlanService } from '../plan.service';
import { SchedulingFeedbackService } from '../scheduling-feedback.service';
import { ewohSchedulePlan } from '@server/database/schema';
import type { WorldStateSnapshot, SchedulingPlanV2 } from '@shared/api.interface';

/** 构造一个可延迟求值的 select 链（返回 plan 行）。 */
function makeSelect(rowsProvider: () => Array<Record<string, unknown>>) {
  const q: any = {
    then: (resolve: (v: unknown) => void) => resolve(rowsProvider()),
    where: () => q,
    orderBy: () => q,
    limit: () => q,
    offset: () => q,
  };
  return q;
}

function makeFakeDb(plans: Array<Record<string, unknown>>) {
  const db: any = {
    select: () => ({
      from: (table: unknown) => {
        if (table === ewohSchedulePlan) return makeSelect(() => plans);
        return makeSelect(() => []);
      },
    }),
  };
  return db;
}

/** 构造 SchedulerService 及最小依赖；worldState.getConfig 返回 minBatteryPct=40。 */
function makeSvc(state: Record<string, unknown>, plans: Array<Record<string, unknown>> = []) {
  const db = makeFakeDb(plans);
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
  const planService = {
    getPlan: jest.fn().mockImplementation(async (planId: string) => {
      const plan = plans.find((p) => p.planId === planId);
      if (!plan) throw new Error(`Plan ${planId} not found`);
      return { planId, status: plan.status } as unknown as SchedulingPlanV2;
    }),
  };
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
      ...state,
    } as never),
    buildSnapshot: jest.fn(),
    getSnapshot: jest.fn(),
    isSnapshotFresh: jest.fn(),
    isPlanStale: jest.fn().mockResolvedValue(false),
    assertFreshForApprove: jest.fn(),
  };

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
    { deriveKpis: jest.fn() } as unknown as SchedulingFeedbackService,
  );

  return { svc, mocks: { worldStateSnapshotService, policyService } };
}

function planRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'id-1',
    planId: 'PLAN-1',
    planName: '方案A',
    status: 'shadow',
    snapshotVersion: 'WS-OLD-0001',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('Task 2: GET /api/scheduler/conflicts 统一冲突列表', () => {
  it('无冲突时返回空列表（不虚构）', async () => {
    const { svc } = makeSvc({
      persons: [{ id: 'p1', name: '张三', status: 'available', dataQuality: 'FRESH' }],
      devices: [{ id: 'd1', batteryPct: 100, online: true, status: 'online', dataQuality: 'FRESH' }],
      routeStatus: [{ edgeId: 'e1', status: 'open', riskLevel: null }],
      tasks: [{ id: 't1', status: 'pending', predecessorIds: [] }],
      stations: [{ id: 's1', name: '工位1', capacity: 5 }],
      backlog: [{ taskId: 's1', count: 2 }],
    });

    const res = await svc.listConflicts({});
    expect(res.total).toBe(0);
    expect(res.conflicts).toEqual([]);
  });

  it('检测到同名资源重叠预占（double booking）', async () => {
    const { svc } = makeSvc({
      reservations: [
        { reservationId: 'R1', resourceId: 'p1', resourceType: 'person', startMs: 100, endMs: 200 },
        { reservationId: 'R2', resourceId: 'p1', resourceType: 'person', startMs: 150, endMs: 250 },
      ],
    });

    const res = await svc.listConflicts({});
    const conflicts = res.conflicts.filter((c) => c.type === 'double_booking');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].resourceId).toBe('p1');
    expect(conflicts[0].severity).toBe('critical');
    expect(conflicts[0].scope).toBe('resource');
    expect(conflicts[0].snapshotVersion).toBe('CURRENT');
  });

  it('检测到设备离线（device offline）', async () => {
    const { svc } = makeSvc({
      devices: [
        { id: 'd1', batteryPct: 100, online: false, status: 'offline', dataQuality: 'FRESH' },
      ],
      tasks: [{ id: 't1', status: 'pending', deviceId: 'd1', assigneeId: null }],
    });

    const res = await svc.listConflicts({});
    const offline = res.conflicts.filter((c) => c.type === 'device_offline');
    expect(offline).toHaveLength(1);
    expect(offline[0].resourceId).toBe('d1');
    expect(offline[0].taskIds).toContain('t1');
  });

  it('检测到路段被阻断（blocked route）', async () => {
    const { svc } = makeSvc({
      routeStatus: [{ edgeId: 'e9', status: 'blocked', riskLevel: 'high' }],
    });

    const res = await svc.listConflicts({});
    const blocked = res.conflicts.filter((c) => c.type === 'blocked_route');
    expect(blocked).toHaveLength(1);
    expect(blocked[0].resourceId).toBe('e9');
    expect(blocked[0].scope).toBe('route');
  });

  it('检测到低电量设备（low battery，低于阈值）', async () => {
    const { svc } = makeSvc({
      devices: [
        { id: 'd1', batteryPct: 20, online: true, status: 'online', dataQuality: 'FRESH' },
      ],
    });

    const res = await svc.listConflicts({});
    const low = res.conflicts.filter((c) => c.type === 'low_battery');
    expect(low).toHaveLength(1);
    expect(low[0].resourceId).toBe('d1');
    expect(low[0].data?.batteryPct).toBe(20);
  });

  it('检测到基于过期快照的方案（stale plan）', async () => {
    const { svc, mocks } = makeSvc(
      {},
      [planRow({ planId: 'PLAN-1', snapshotVersion: 'WS-OLD-0001' })],
    );
    mocks.worldStateSnapshotService.isPlanStale.mockResolvedValue(true);

    const res = await svc.listConflicts({});
    const stale = res.conflicts.filter((c) => c.type === 'stale_plan');
    expect(stale).toHaveLength(1);
    expect(stale[0].resourceId).toBeNull();
    expect(stale[0].snapshotVersion).toBe('WS-OLD-0001');
    expect(mocks.worldStateSnapshotService.isPlanStale).toHaveBeenCalledWith('WS-OLD-0001');
  });

  it('按 type / severity / resourceId 过滤', async () => {
    const { svc } = makeSvc({
      devices: [
        { id: 'd1', batteryPct: 10, online: false, status: 'offline', dataQuality: 'FRESH' },
      ],
    });

    const res = await svc.listConflicts({ type: 'device_offline', severity: 'high' });
    expect(res.conflicts.every((c) => c.type === 'device_offline')).toBe(true);
    expect(res.conflicts.every((c) => c.severity === 'high')).toBe(true);

    const byRes = await svc.listConflicts({ resourceId: 'd1' });
    expect(byRes.conflicts.every((c) => c.resourceId === 'd1')).toBe(true);
  });
});

describe('Task 2: GET /api/scheduler/conflicts/:id 冲突详情', () => {
  it('返回存在的冲突详情', async () => {
    const { svc } = makeSvc({
      devices: [
        { id: 'd1', batteryPct: 100, online: false, status: 'offline', dataQuality: 'FRESH' },
      ],
    });

    const list = await svc.listConflicts({ type: 'device_offline' });
    const detail = await svc.getConflictDetail(list.conflicts[0].conflictId);
    expect(detail.conflictId).toBe(list.conflicts[0].conflictId);
    expect(detail.type).toBe('device_offline');
  });

  it('冲突不存在时抛 NotFoundException', async () => {
    const { svc } = makeSvc({});
    await expect(svc.getConflictDetail('CFL-nonexistent')).rejects.toThrow('Conflict CFL-nonexistent not found');
  });
});