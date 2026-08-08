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
  return q;
}

export function makeFakeDb(seed: FakeDbSeed = {}) {
  const state: FakeDbState = {
    plans: new Map((seed.plans ?? []).map((p) => [String(p.planId), { ...p }])),
    assignments: (seed.assignments ?? []).map((a) => ({ ...a })),
    tasks: new Map((seed.tasks ?? []).map((t) => [String(t.id), { ...t }])),
    events: [],
    audits: [],
    constraints: [],
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
        where: () => {
          if (table === ewohSchedulePlan) {
            const plan = Array.from(state.plans.values())[0];
            if (!plan) return { returning: () => Promise.resolve([]) };
            // dispatch 的 CAS 更新要求当前状态为 approved；approve/reject 为无条件更新。
            if (patch.status === 'dispatched' && plan.status !== 'approved') {
              return { returning: () => Promise.resolve([]) };
            }
            Object.assign(plan, patch);
            return { returning: () => Promise.resolve([plan]) };
          }
          if (table === ewohSchedulingPlanAssignment) {
            for (const a of state.assignments) Object.assign(a, patch);
            return { returning: () => Promise.resolve([...state.assignments]) };
          }
          if (table === ewohProductionTask) {
            for (const t of state.tasks.values()) Object.assign(t, patch);
            return { returning: () => Promise.resolve([...state.tasks.values()]) };
          }
          if (table === ewohSchedulingFeedback) {
            for (const f of state.feedback) Object.assign(f, patch);
            return { returning: () => Promise.resolve([...state.feedback]) };
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
  const requestDatabaseContext = {
    runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => {
      await cb();
    }),
  };
  const worldStateSnapshotService = {
    assertFreshForApprove: jest.fn().mockResolvedValue(undefined),
  };
  const reservationService = {
    reserve: jest.fn().mockResolvedValue([]),
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

  const svc = new DispatchCoordinatorService(
    db,
    requestDatabaseContext as unknown as RequestDatabaseContext,
    worldStateSnapshotService as unknown as WorldStateSnapshotService,
    reservationService as unknown as ResourceReservationService,
    outboxService as unknown as OutboxService,
    auditService as unknown as AuditService,
    taskService as unknown as TaskService,
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
    },
  };
}

/** 构造 PlanService 及其 mock 依赖（含 DispatchCoordinator）。 */
export function makePlanService(seed: FakeDbSeed = {}) {
  const { db, state } = makeFakeDb(seed);
  const requestDatabaseContext = {
    runInTransaction: jest.fn(async (_guc: unknown, cb: () => Promise<void>) => {
      await cb();
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
    buildSnapshot: jest.fn(),
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

  const svc = new PlanService(
    db,
    requestDatabaseContext as unknown as RequestDatabaseContext,
    auditService as unknown as AuditService,
    solverService as unknown as SolverService,
    worldStateSnapshotService as unknown as WorldStateSnapshotService,
    dispatchCoordinator as unknown as DispatchCoordinatorService,
    schedulingPolicyService as unknown as SchedulingPolicyService,
  );

  return { svc, db, state, mocks: { requestDatabaseContext, auditService, solverService, worldStateSnapshotService, dispatchCoordinator, schedulingPolicyService } };
}