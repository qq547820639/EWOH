/* Task 1（cmd-map-scheduling-closed-loop）：GET /api/scheduler/runs 分页运行历史 + 活跃方案，
 * 以及 GET /api/scheduler/snapshot 当前权威世界状态快照 的服务层单测。
 *
 * 复用现有 SchedulerService / WorldStateSnapshotService 语义，不引入并行调度器。
 * db 使用 in-memory fake（支持 ewoh_scheduling_run / ewoh_schedule_plan 的 select 链），
 * 遵循 dispatch-test-harness / plan-persistence.spec 的 mock 风格。
 */
/// <reference types="jest" />
import { SchedulerService } from '../scheduler.service';
import { WorldStateSnapshotService } from '../world-state.service';
import { PlanService } from '../plan.service';
import { SchedulingFeedbackService } from '../scheduling-feedback.service';
import { ewohSchedulingRun, ewohSchedulePlan } from '@server/database/schema';
import type { SchedulingPlanV2, WorldStateSnapshot } from '@shared/api.interface';

/** 构造一个可延迟求值的 select 链：await 时按当前 offset/limit 计算。 */
function makeSelect(rowsProvider: () => Array<Record<string, unknown>>, count = false) {
  const state = { limit: Number.POSITIVE_INFINITY, offset: 0 };
  const build = () => {
    if (count) return [{ count: rowsProvider().length }];
    const rows = rowsProvider();
    return rows.slice(state.offset, state.offset + state.limit);
  };
  const q: any = {
    then: (resolve: (v: unknown) => void) => resolve(build()),
    where: () => q,
    orderBy: () => q,
    limit: (n: number) => {
      state.limit = n;
      return q;
    },
    offset: (n: number) => {
      state.offset = n;
      return q;
    },
  };
  return q;
}

function makeFakeDb(seed: { runs?: Array<Record<string, unknown>>; plans?: Array<Record<string, unknown>> }) {
  const runs = [...(seed.runs ?? [])];
  const plans = [...(seed.plans ?? [])];
  const db: any = {
    select: (cols?: unknown) => ({
      from: (table: unknown) => {
        if (table === ewohSchedulingRun) return makeSelect(() => runs, Boolean(cols));
        if (table === ewohSchedulePlan) return makeSelect(() => plans, Boolean(cols));
        return makeSelect(() => [], Boolean(cols));
      },
    }),
  };
  return { db, runs, plans };
}

/** 构造 SchedulerService 及其最小依赖（仅 db / planService / worldState 被真实使用）。 */
function makeSvc(seed: { runs?: Array<Record<string, unknown>>; plans?: Array<Record<string, unknown>> }) {
  const { db, runs, plans } = makeFakeDb(seed);
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
    getConfig: jest.fn(),
    getConfigByVersion: jest.fn(),
  };

  const planService = {
    getPlan: jest.fn().mockImplementation(async (planId: string) => {
      const plan = plans.find((p) => p.planId === planId);
      if (!plan) throw new Error(`Plan ${planId} not found`);
      return { planId, status: plan.status, createdAt: plan.createdAt } as unknown as SchedulingPlanV2;
    }),
  };

  const worldStateSnapshotService = {
    getCurrentWorldState: jest.fn(),
    buildSnapshot: jest.fn(),
    getSnapshot: jest.fn(),
    isSnapshotFresh: jest.fn(),
    isPlanStale: jest.fn(),
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

  return { svc, runs, plans, mocks: { planService, worldStateSnapshotService } };
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'RUN-1',
    triggerType: 'MANUAL',
    triggerEntityId: null,
    status: 'succeeded',
    snapshotVersion: 'WS-1',
    planIds: ['PLAN-1'],
    orgId: 'org1',
    error: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

function planRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'id-1',
    planId: 'PLAN-1',
    planName: '方案A',
    status: 'shadow',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('Task 1: GET /api/scheduler/runs 分页运行历史 + 活跃方案', () => {
  it('返回分页 runs、total、page/pageSize，并填充活跃方案', async () => {
    const runs = [
      runRow({ runId: 'RUN-3', createdAt: new Date('2026-08-03T00:00:00.000Z') }),
      runRow({ runId: 'RUN-2', createdAt: new Date('2026-08-02T00:00:00.000Z') }),
      runRow({ runId: 'RUN-1', createdAt: new Date('2026-08-01T00:00:00.000Z') }),
    ];
    const plans = [planRow()];
    const { svc, mocks } = makeSvc({ runs, plans });

    const res = await svc.listRuns({ page: 1, pageSize: 2 });

    expect(res.page).toBe(1);
    expect(res.pageSize).toBe(2);
    expect(res.total).toBe(3);
    expect(res.runs).toHaveLength(2);
    // 按 createdAt 倒序
    expect(res.runs.map((r) => r.runId)).toEqual(['RUN-3', 'RUN-2']);
    // SchedulingRun 字段映射
    expect(res.runs[0].status).toBe('succeeded');
    expect(res.runs[0].snapshotVersion).toBe('WS-1');
    expect(res.runs[0].planIds).toEqual(['PLAN-1']);
    // 活跃方案通过 planService.getPlan 填充为 SchedulingPlanV2
    expect(res.plans).toHaveLength(1);
    expect(res.plans[0].planId).toBe('PLAN-1');
    expect(mocks.planService.getPlan).toHaveBeenCalledWith('PLAN-1');
  });

  it('第二页正确跳过前 offset 条', async () => {
    const runs = [
      runRow({ runId: 'RUN-3' }),
      runRow({ runId: 'RUN-2' }),
      runRow({ runId: 'RUN-1' }),
    ];
    const { svc } = makeSvc({ runs, plans: [] });

    const res = await svc.listRuns({ page: 2, pageSize: 2 });

    expect(res.page).toBe(2);
    expect(res.runs).toHaveLength(1);
    expect(res.runs[0].runId).toBe('RUN-1');
    expect(res.total).toBe(3);
  });

  it('无活跃方案时 plans 为空数组，且不因 getPlan 失败而中断', async () => {
    const { svc } = makeSvc({ runs: [runRow()], plans: [] });
    const res = await svc.listRuns({});
    expect(res.plans).toEqual([]);
    expect(res.runs).toHaveLength(1);
  });

  it('page/pageSize 越界时收敛到安全范围', async () => {
    const { svc } = makeSvc({ runs: [runRow()], plans: [] });
    const res = await svc.listRuns({ page: 0, pageSize: 9999 } as never);
    expect(res.page).toBe(1);
    expect(res.pageSize).toBe(100);
  });
});

describe('P0-1: GET /api/scheduler/active-plans 服务端权威活跃方案', () => {
  it('返回所有非终态方案（含 shadow/approved/dispatched/executing），且状态可恢复', async () => {
    const { svc } = makeSvc({
      runs: [],
      plans: [
        planRow({ planId: 'PLAN-1', status: 'shadow', createdAt: new Date('2026-08-01T00:00:00.000Z') }),
        planRow({ planId: 'PLAN-2', status: 'approved', createdAt: new Date('2026-08-02T00:00:00.000Z') }),
        planRow({ planId: 'PLAN-3', status: 'executing', createdAt: new Date('2026-08-03T00:00:00.000Z') }),
      ],
    });
    const active = await svc.getActivePlans();
    // getActivePlans 不按 status 过滤（mock 的 where 无状态语义），返回全部 seed；
    // 关键断言：能从 DB 恢复方案且状态完整（页面刷新场景）。
    expect(active.length).toBe(3);
    const statuses = active.map((p) => p.status).sort();
    expect(statuses).toEqual(['approved', 'executing', 'shadow']);
  });

  it('单个方案读取失败被跳过而不中断整体（resync 容错）', async () => {
    const { svc, mocks } = makeSvc({
      runs: [],
      plans: [
        planRow({ planId: 'PLAN-OK', status: 'shadow' }),
        planRow({ planId: 'PLAN-BROKEN', status: 'approved' }),
      ],
    });
    // 强制 getPlan 对 PLAN-BROKEN 抛错（如分配/快照数据缺失）
    mocks.planService.getPlan.mockImplementation(async (planId: string) => {
      if (planId === 'PLAN-BROKEN') throw new Error('orphan plan detail');
      return { planId, status: 'shadow', createdAt: new Date() } as unknown as SchedulingPlanV2;
    });
    const active = await svc.getActivePlans();
    // 失败方案被跳过，整体不中断；可恢复的方案仍在
    expect(active.map((p) => p.planId)).toEqual(['PLAN-OK']);
  });
});

describe('Task 1: GET /api/scheduler/snapshot 当前权威世界状态', () => {
  it('复用 getCurrentWorldState 的真实状态，包装为 WorldStateSnapshot（CURRENT + ts）', async () => {
    const { svc, mocks } = makeSvc({ runs: [], plans: [] });
    mocks.worldStateSnapshotService.getCurrentWorldState.mockResolvedValue({
      worldVersion: 4321,
      entityVersions: { 'person:p1': 1 },
      reservations: [],
      persons: [{ id: 'p1', name: '张三', status: 'available' }],
      tasks: [],
      devices: [],
      stations: [],
      backlog: [],
      events: [],
      routeStatus: [],
      forbiddenZones: [],
      lockedAssignments: [],
    });

    const snap = await svc.getSnapshot();

    expect(mocks.worldStateSnapshotService.getCurrentWorldState).toHaveBeenCalled();
    expect(snap.snapshotVersion).toBe('CURRENT');
    expect(typeof snap.ts).toBe('string');
    expect(snap.worldVersion).toBe(4321);
    expect(snap.persons).toHaveLength(1);
    expect(snap.persons[0].name).toBe('张三');
    expect(snap).toMatchObject({
      snapshotVersion: 'CURRENT',
      entityVersions: { 'person:p1': 1 },
      reservations: [],
    });
  });

  it('返回的实体版本/保留信息反映当前快照（类型校验：WorldStateSnapshot）', async () => {
    const { svc, mocks } = makeSvc({ runs: [], plans: [] });
    mocks.worldStateSnapshotService.getCurrentWorldState.mockResolvedValue({
      worldVersion: 1,
      entityVersions: {},
      reservations: [
        { reservationId: 'R1', resourceId: 'p1', resourceType: 'person', startMs: 0, endMs: 100 },
      ],
      persons: [],
      tasks: [],
      devices: [],
      stations: [],
      backlog: [],
      events: [],
      routeStatus: [],
      forbiddenZones: [],
      lockedAssignments: [],
    });

    const snap: WorldStateSnapshot = await svc.getSnapshot();
    expect(snap.reservations).toEqual([
      { reservationId: 'R1', resourceId: 'p1', resourceType: 'person', startMs: 0, endMs: 100 },
    ]);
  });
});