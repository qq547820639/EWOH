/* Dispatch / Plan 服务的状态化 in-memory fake DB 与协调器构造。
 *
 * 通过 drizzle 链式 API（select/insert/update）模拟 ewoh 各表，供并发与集成测试使用，
 * 不依赖真实 Postgres。本文件非 spec，不会被 jest 运行为测试。
 */
/// <reference types="jest" />
import {
  ewohSchedulePlan,
  ewohSchedulingPlanAssignment,
  ewohSchedulingConstraint,
  ewohProductionTask,
  ewohAssignmentEvent,
  ewohScheduleAudit,
  ewohResourceReservation,
  ewohSchedulingFeedback,
} from '@server/database/schema';
import { DispatchCoordinatorService } from '../dispatch-coordinator.service';
import { RequestDatabaseContext } from '@server/database/request-database-context';
import { WorldStateSnapshotService } from '../world-state.service';
import { ResourceReservationService } from '../resource-reservation.service';
import { OutboxService } from '../outbox.service';
import { AuditService } from '@server/modules/shared/audit.service';
import { TaskService } from '@server/modules/task/task.service';
import { PlanService } from '../plan.service';
import { SolverService } from '../solver.service';
import { SchedulingPolicyService } from '../scheduling-policy.service';
import type { OrgContext } from '@server/modules/shared/org-context.interceptor';

export interface FakeDbSeed {
  plans?: Array<Record<string, unknown>>;
  assignments?: Array<Record<string, unknown>>;
  tasks?: Array<Record<string, unknown>>;
  /** P0-2：持久化调度约束（ewoh_scheduling_constraint）。 */
  constraints?: Array<Record<string, unknown>>;
  /** 为 true 时方案 select 恒返回 approved，用于并发 CAS 测试。 */
  forcePlanApproved?: boolean;
}

export interface FakeDbState {
  plans: Map<string, Record<string, unknown>>;
  assignments: Array<Record<string, unknown>>;
  tasks: Map<string, Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
  constraints: Array<Record<string, unknown>>;
  reservations: Array<Record<string, unknown>>;
  feedback: Array<Record<string, unknown>>;
}

/** 构造一个可 await 且带 where/limit/orderBy 链的最小查询对象。 */
function makeQuery(rowsProvider: () => Array<Record<string, unknown>>) {
  const run = () => rowsProvider();
  const q: any = Promise.resolve(run());
  q.where = () => makeQuery(rowsProvider);
  q.limit = (n?: number) => Promise.resolve(run().slice(0, n ?? run().length));
  q.orderBy = () => makeQuery(rowsProvider);
  // NO-39a：派工事务会对设备行加锁（`SELECT ... FOR UPDATE`）——替身必须同形提供
  // `.for()`，否则真实写路径在测试里直接 TypeError（与"替身漂移"同一类坑）。
  q.for = () => makeQuery(rowsProvider);
  return q;
}

/**
 * R2-SPT-003：drizzle SQL 谓词对象的 DB 列名 → 行字段名映射（update 定位行用）。
 */
const COL_TO_KEY: Record<string, string> = {
  plan_id: 'planId',
  assignment_id: 'assignmentId',
  constraint_id: 'constraintId',
  feedback_id: 'feedbackId',
  reservation_id: 'reservationId',
  run_id: 'runId',
  task_id: 'taskId',
  resource_id: 'resourceId',
  person_id: 'personId',
  device_id: 'deviceId',
  station_id: 'stationId',
  org_id: 'orgId',
  status: 'status',
  active: 'active',
  version: 'version',
  id: 'id',
};

/**
 * R2-SPT-003：从 drizzle SQL 谓词对象递归求值（复用 policy-version.spec 的
 * R2-SSV-01 模式）：支持 eq / isNull / and / or——按 or 分组，组内合取，
 * 组间析取。原 fake-db update() 完全忽略 where（plans 恒改首行、其余表恒改
 * 全表），掩盖真实 UPDATE...WHERE 行级语义与 0 行分支。
 */
function matchesEq(row: Record<string, unknown>, sqlExpr: unknown): boolean {
  const chunks = (sqlExpr as { queryChunks?: unknown[] } | undefined)?.queryChunks;
  if (!Array.isArray(chunks)) return true;
  const groups: Array<Array<() => boolean>> = [[]];
  let pendingCol: string | null = null;
  // 本仓 drizzle 版本的 StringChunk.value 为 string[]（如 [" and "]），
  // 兼容旧形态纯 string。
  const chunkText = (o: { value?: unknown }): string | null => {
    if (Array.isArray(o.value) && o.value.every((s) => typeof s === 'string')) {
      return o.value.join('');
    }
    if (typeof o.value === 'string') return o.value;
    return null;
  };
  for (const raw of chunks) {
    const c = raw as {
      name?: string;
      value?: unknown;
      encoder?: unknown;
      queryChunks?: unknown[];
    } | undefined;
    if (!c || typeof c !== 'object') continue;
    if (typeof c.name === 'string' && !('encoder' in c)) {
      pendingCol = c.name;
      continue;
    }
    if (!('encoder' in c)) {
      const text = chunkText(c);
      if (text !== null) {
        if (/\bor\b/.test(text)) groups.push([]);
        else if (/is\s+null/i.test(text) && pendingCol) {
          const key = COL_TO_KEY[pendingCol] ?? pendingCol;
          groups[groups.length - 1].push(() => row[key] == null);
          pendingCol = null;
        }
        continue;
      }
    }
    if ('encoder' in c && 'value' in c && pendingCol) {
      const key = COL_TO_KEY[pendingCol] ?? pendingCol;
      const expected = c.value;
      groups[groups.length - 1].push(() => row[key] === expected);
      pendingCol = null;
      continue;
    }
    if (Array.isArray(c.queryChunks)) {
      const nested = raw;
      groups[groups.length - 1].push(() => matchesEq(row, nested));
    }
  }
  if (groups.every((g) => g.length === 0)) return true;
  return groups.some((g) => g.every((fn) => fn()));
}

export function makeFakeDb(seed: FakeDbSeed = {}) {
  const state: FakeDbState = {
    plans: new Map((seed.plans ?? []).map((p) => [String(p.planId), { ...p }])),
    assignments: (seed.assignments ?? []).map((a) => ({ ...a })),
    tasks: new Map((seed.tasks ?? []).map((t) => [String(t.id), { ...t }])),
    events: [],
    audits: [],
    constraints: (seed.constraints ?? []).map((c) => ({ ...c })),
    reservations: [],
    feedback: [],
  };

  const rowsOf = (table: unknown) => {
    if (table === ewohSchedulePlan)
      return Array.from(state.plans.values()).map((p) =>
        seed.forcePlanApproved ? { ...p, status: 'approved' } : p,
      );
    if (table === ewohSchedulingPlanAssignment) return state.assignments;
    if (table === ewohProductionTask) return Array.from(state.tasks.values());
    if (table === ewohSchedulingConstraint) return state.constraints;
    if (table === ewohResourceReservation) return state.reservations;
    if (table === ewohSchedulingFeedback) return state.feedback;
    return [];
  };

  const db: any = {
    select: () => ({ from: (table: unknown) => makeQuery(() => rowsOf(table)) }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        const arr = (Array.isArray(values) ? values : [values]) as Array<
          Record<string, unknown>
        >;
        for (const row of arr) {
          if (table === ewohSchedulePlan && row.planId)
            state.plans.set(String(row.planId), row);
          else if (table === ewohSchedulingPlanAssignment) state.assignments.push(row);
          else if (table === ewohProductionTask && row.id)
            state.tasks.set(String(row.id), row);
          else if (table === ewohAssignmentEvent) state.events.push(row);
          else if (table === ewohScheduleAudit) state.audits.push(row);
          else if (table === ewohSchedulingConstraint) state.constraints.push(row);
          else if (table === ewohResourceReservation) state.reservations.push(row);
          else if (table === ewohSchedulingFeedback) state.feedback.push(row);
        }
        return {
          returning: () => Promise.resolve(arr.length ? [arr[0]] : []),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        // R2-SPT-003：update 按 where 谓词定位行（等值匹配 + and/or/isNull
        // 嵌套，见 matchesEq）——plans 不再恒改首行、其余表不再恒改全表；
        // dispatch 的 CAS 由调用方谓词 and(planId, status='approved') 真实
        // 承载；无命中返回空 returning 以暴露 0 行分支。
        where: (pred: unknown) => {
          if (table === ewohSchedulePlan) {
            const hit: Array<Record<string, unknown>> = [];
            for (const plan of state.plans.values()) {
              if (matchesEq(plan, pred)) {
                Object.assign(plan, patch);
                hit.push(plan);
              }
            }
            return { returning: () => Promise.resolve(hit) };
          }
          if (table === ewohSchedulingPlanAssignment) {
            const hit = state.assignments.filter((a) => matchesEq(a, pred));
            for (const a of hit) Object.assign(a, patch);
            return { returning: () => Promise.resolve([...hit]) };
          }
          if (table === ewohProductionTask) {
            const hit: Array<Record<string, unknown>> = [];
            for (const t of state.tasks.values()) {
              if (matchesEq(t, pred)) {
                Object.assign(t, patch);
                hit.push(t);
              }
            }
            return { returning: () => Promise.resolve(hit) };
          }
          if (table === ewohSchedulingFeedback) {
            const hit = state.feedback.filter((f) => matchesEq(f, pred));
            for (const f of hit) Object.assign(f, patch);
            return { returning: () => Promise.resolve([...hit]) };
          }
          if (table === ewohSchedulingConstraint) {
            // NEST-028：deactivate 软删除（active=false）——命中行语义同上。
            const hit = state.constraints.filter((c) => matchesEq(c, pred));
            for (const c of hit) Object.assign(c, patch);
            return { returning: () => Promise.resolve([...hit]) };
          }
          if (table === ewohResourceReservation) {
            const hit = state.reservations.filter((r) => matchesEq(r, pred));
            for (const r of hit) Object.assign(r, patch);
            return { returning: () => Promise.resolve([...hit]) };
          }
          return { returning: () => Promise.resolve([]) };
        },
      }),
    }),
  };

  return { db, state };
}

export function testOrgContext(): OrgContext {
  return { userId: 'u1', primaryOrgId: 'org1' };
}

/** 构造 DispatchCoordinatorService 及其全部 mock 依赖。 */
export function makeDispatchCoordinator(seed: FakeDbSeed = {}) {
  const { db, state } = makeFakeDb(seed);
  // 内存替身必须模拟 PostgreSQL 事务隔离的串行提交语义；否则并发测试会
  // 允许两个事务同时读到同一 version，掩盖生产库中真实存在的 CAS 行为。
  let transactionTail: Promise<unknown> = Promise.resolve();
  const requestDatabaseContext = {
    runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => {
      const run = transactionTail.then(() => cb());
      transactionTail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }),
  };
  const worldStateSnapshotService = {
    assertFreshForApprove: jest.fn().mockResolvedValue(undefined),
    // 分波次派工新增协作方法：替身必须同形实现，否则波次派工路径不可测。
    assertFreshForWave: jest.fn().mockResolvedValue(undefined),
    // v0.7 Batch6.3 SAFETY 熔断：默认无阻断资源（空集）
    getCurrentWorldState: jest.fn().mockResolvedValue({
      safetyBlockedPersonIds: [],
      safetyBlockedDeviceIds: [],
    }),
  };
  const reservationService = {
    reserve: jest.fn().mockResolvedValue([]),
    // P0-7：dispatch 前 station 容量预检。
    assertStationCapacityAvailable: jest.fn().mockResolvedValue(undefined),
  };
  const outboxService = {
    enqueue: jest.fn().mockResolvedValue({
      id: 'evt-outbox-1',
      eventType: 'assignment.dispatched',
      entityId: 'asg-1',
      payload: {},
      status: 'pending',
      sequence: 1,
      createdAt: new Date().toISOString(),
    }),
  };
  const auditService = {
    appendAuditLog: jest.fn().mockResolvedValue(undefined),
  };
  const taskService = {
    transitionTaskState: jest.fn().mockResolvedValue(undefined),
  };
  const feedbackService = {
    recordBaseline: jest.fn().mockResolvedValue(undefined),
  };
  const policyService = {
    getConfig: jest.fn().mockResolvedValue({ defaultTaskDurationMs: 1_800_000 }),
  };
  // §5.4：ADVISORY 模式 safety-critical 路线阻断判定（默认 route_graph 不阻断）。
  const travelCostService = {
    estimate: jest.fn().mockResolvedValue({
      routeId: 'R', distanceMeters: 10, etaSeconds: 10, riskLevel: null,
      feasible: true, source: 'route_graph', riskCost: 0, congestionCost: 0,
      graphVersion: null, calculatedAt: new Date().toISOString(),
      fallbackReason: null, dataQuality: 'FRESH',
    }),
  };

  const svc = new DispatchCoordinatorService(
    db,
    requestDatabaseContext as unknown as RequestDatabaseContext,
    worldStateSnapshotService as unknown as WorldStateSnapshotService,
    reservationService as unknown as ResourceReservationService,
    outboxService as unknown as OutboxService,
    auditService as unknown as AuditService,
    taskService as unknown as TaskService,
    feedbackService as unknown as import('../scheduling-feedback.service').SchedulingFeedbackService,
    policyService as unknown as import('../scheduling-policy.service').SchedulingPolicyService,
    travelCostService as unknown as import('../travel-cost.service').TravelCostService,
  );

  return {
    svc,
    db,
    state,
    mocks: {
      requestDatabaseContext,
      worldStateSnapshotService,
      reservationService,
      outboxService,
      auditService,
      taskService,
      feedbackService,
      policyService,
      travelCostService,
    },
  };
}

/** 构造 PlanService 及其 mock 依赖（含 DispatchCoordinator）。 */
export function makePlanService(seed: FakeDbSeed = {}) {
  const { db, state } = makeFakeDb(seed);
  // 内存替身必须模拟 PostgreSQL 事务隔离的串行提交语义；否则并发测试会
  // 允许两个事务同时读到同一 version，掩盖生产库中真实存在的 CAS 行为。
  let transactionTail: Promise<unknown> = Promise.resolve();
  const requestDatabaseContext = {
    runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => {
      const run = transactionTail.then(() => cb());
      transactionTail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }),
  };
  const auditService = {
    appendAuditLog: jest.fn().mockResolvedValue(undefined),
  };
  const solverService = {
    solve: jest.fn(),
    solveVariants: jest.fn(),
  };
  const worldStateSnapshotService = {
    assertFreshForApprove: jest.fn().mockResolvedValue(undefined),
    // 分波次派工新增协作方法：替身必须同形实现，否则波次派工路径不可测。
    assertFreshForWave: jest.fn().mockResolvedValue(undefined),
    buildSnapshot: jest.fn(),
    getCurrentWorldState: jest.fn().mockResolvedValue({
      safetyBlockedPersonIds: [],
      safetyBlockedDeviceIds: [],
    }),
  };
  const dispatchCoordinator = {
    dispatch: jest.fn(),
  };
  const schedulingPolicyService = {
    getActivePolicy: jest.fn(),
    getPolicy: jest.fn(),
    getConfig: jest.fn(),
    getConfigByVersion: jest.fn(),
  };
  const feedbackService = {
    recordAcceptance: jest.fn().mockResolvedValue(undefined),
    recordBaseline: jest.fn().mockResolvedValue(undefined),
  };
  const constraintLoaderService = {
    loadForPlan: jest.fn().mockImplementation(async (_planId: string, requestConstraints: unknown[]) => requestConstraints),
    hashConstraints: jest.fn().mockReturnValue('hash'),
  };
  const outboxService = {
    enqueue: jest.fn().mockResolvedValue({
      id: 'evt-outbox-1',
      eventType: 'stale_plan',
      entityId: 'asg-1',
      payload: {},
      status: 'pending',
      sequence: 1,
      createdAt: new Date().toISOString(),
    }),
  };
  const replanCoordinator = {
    handleTrigger: jest.fn().mockResolvedValue(undefined),
  };

  const svc = new PlanService(
    db,
    requestDatabaseContext as unknown as RequestDatabaseContext,
    auditService as unknown as AuditService,
    solverService as unknown as SolverService,
    worldStateSnapshotService as unknown as WorldStateSnapshotService,
    dispatchCoordinator as unknown as DispatchCoordinatorService,
    schedulingPolicyService as unknown as SchedulingPolicyService,
    feedbackService as unknown as import('../scheduling-feedback.service').SchedulingFeedbackService,
    constraintLoaderService as unknown as import('../constraint-loader.service').ConstraintLoaderService,
    outboxService as unknown as OutboxService,
    replanCoordinator as unknown as import('../replan-coordinator.service').ReplanCoordinatorService,
  );

  return {
    svc,
    db,
    state,
    mocks: {
      requestDatabaseContext,
      auditService,
      solverService,
      worldStateSnapshotService,
      dispatchCoordinator,
      schedulingPolicyService,
      feedbackService,
      constraintLoaderService,
      outboxService,
      replanCoordinator,
    },
  };
}