/* plan-org-isolation.spec.ts — 方案行组织隔离闭环（ADR-071 / NO-13v，§15）。
 *
 * 覆盖：
 *  - plan-tenant-guard 纯守卫语义（actor 缺失/NULL 存量/同租户放行/跨租户 404）；
 *  - PlanService 读面 getPlan(actor) 与变面 approve/reject/dispatch/replan 守卫；
 *  - getPlan 读模型 orgId 透出（toPlanV2）+ persistPlan 写 orgId（ctx 归属）；
 *  - SchedulerQueryService getPlans/getActivePlans org 条件注入（SQL 形状断言）。
 *
 * 语义与 standalone_025 RLS 分支逐字对齐：org 匹配或 NULL（存量/全局）放行，
 * 其余与"方案不存在"同语义（NotFound，反枚举）。
 */
import { NotFoundException } from '@nestjs/common';
import { PlanService } from '../../../server/modules/scheduler/plan.service';
import { SchedulerQueryService } from '../../../server/modules/scheduler/scheduler-query.service';
import {
  assertPlanTenantVisible,
  assertTenantVisible,
} from '../../../server/modules/scheduler/plan-tenant-guard';
import {
  ewohSchedulePlan,
  ewohSchedulingPlanAssignment,
  ewohSchedulingConstraint,
} from '@server/database/schema';
import type { SchedulingPlanV2 } from '@shared/scheduler';

const PLAN_ID = 'PLAN-ORG-1';
const CTX_ORG1 = { userId: 'u1', primaryOrgId: 'ORG-1' } as never;
const CTX_ORG2 = { userId: 'u2', primaryOrgId: 'ORG-2' } as never;

describe('assertPlanTenantVisible 纯守卫（ADR-071）', () => {
  it('actor 缺失（内部可信流）→ 放行（RLS 兜底）', () => {
    expect(() => assertPlanTenantVisible('ORG-1', undefined)).not.toThrow();
    expect(() => assertPlanTenantVisible('ORG-1', null)).not.toThrow();
  });

  it('planOrgId NULL（standalone_025 存量/全局过渡行）→ 放行', () => {
    expect(() => assertPlanTenantVisible(null, CTX_ORG2, PLAN_ID)).not.toThrow();
    expect(() => assertPlanTenantVisible(undefined, CTX_ORG2, PLAN_ID)).not.toThrow();
  });

  it('同租户 org 匹配 → 放行', () => {
    expect(() => assertPlanTenantVisible('ORG-1', CTX_ORG1, PLAN_ID)).not.toThrow();
  });

  it('跨租户 → NotFound（与方案不存在同语义，反枚举）', () => {
    let thrown: unknown;
    try {
      assertPlanTenantVisible('ORG-1', CTX_ORG2, PLAN_ID);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect((thrown as Error).message).toContain(PLAN_ID);
  });
});

// ===== PlanService harness（与 plan-decision-persistence.spec.ts 同构） =====

function makePlanRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'id-1',
    planId: PLAN_ID,
    planName: 'plan-a',
    strategy: 'scheduling_v2',
    status: 'shadow',
    version: 1,
    snapshotVersion: 'WS-1',
    triggerType: 'MANUAL',
    triggerEntityId: null,
    metricsJson: {},
    baselineDeltaJson: {},
    violationsJson: [],
    constraintsJson: [],
    policyVersion: 8,
    solverVersion: 'heuristic-v2',
    horizonMinutes: 480,
    scoreBreakdownJson: null,
    weightsJson: null,
    effectiveConstraintsHash: null,
    decisionRecordsJson: null,
    orgId: 'ORG-1',
    isShadow: false,
    createdAt: new Date('2026-08-16T08:00:00Z'),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeAssignmentRow(): Record<string, unknown> {
  return {
    assignmentId: 'ASG-ORG-1',
    planId: PLAN_ID,
    taskId: 'task:t-1001',
    personId: 'person:p1',
    deviceId: null,
    stationId: 'station:s1',
    zoneId: null,
    plannedStart: new Date('2026-08-16T08:00:00Z'),
    plannedEnd: new Date('2026-08-16T08:30:00Z'),
    routeId: null,
    etaSeconds: null,
    distanceMeters: null,
    riskLevel: null,
    status: 'proposed',
    explanationJson: null,
    scoreBreakdownJson: null,
    decisionTraceJson: null,
  };
}

function makePlan(): SchedulingPlanV2 {
  return {
    planId: PLAN_ID,
    version: 1,
    status: 'shadow',
    trigger: { type: 'MANUAL', entityId: null },
    snapshotVersion: 'WS-1',
    policyVersion: 8,
    solverVersion: 'heuristic-v2',
    horizonMinutes: 480,
    assignments: [],
    metrics: {
      lateMinutes: 0,
      walkingMeters: 0,
      stationWaitMinutes: 0,
      maxWorkload: 0,
      changeCost: 0,
    },
    baselineDelta: {},
    violations: [],
    createdAt: '2026-08-16T08:00:00Z',
  };
}

function makePlanService(planRow: Record<string, unknown>) {
  const updatePatches: Array<Record<string, unknown>> = [];
  const insertedPlans: Array<Record<string, unknown>> = [];
  const dispatchCalls: string[] = [];
  function thenable(data: unknown[]): unknown {
    return {
      then: (resolve: (v: unknown[]) => void) => resolve(data),
      limit: jest.fn(async () => data.slice(0, 10)),
      orderBy: jest.fn(async () => data),
    };
  }
  const capturedConditions: Array<{ table: unknown; cond: unknown }> = [];
  const db = {
    select: jest.fn((_table: unknown) => ({
      from: jest.fn((table2: unknown) => ({
        where: jest.fn((cond: unknown) => {
          capturedConditions.push({ table: table2, cond });
          if (table2 === ewohSchedulePlan) return thenable([planRow]);
          if (table2 === ewohSchedulingPlanAssignment) return thenable([makeAssignmentRow()]);
          return thenable([]);
        }),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn((patch: Record<string, unknown>) => {
        updatePatches.push(patch);
        return { where: jest.fn(async () => []) };
      }),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        if (table === ewohSchedulePlan) insertedPlans.push(row);
        return { returning: jest.fn(async () => [row]) };
      }),
    })),
  } as never;
  const requestDatabaseContext = {
    runInTransaction: jest.fn(async (_settings: unknown, fn: () => Promise<void>) => {
      await fn();
    }),
  };
  const auditService = {
    appendAuditLog: jest.fn(async () => undefined),
    insertAudit: jest.fn(async () => undefined),
  };
  const worldStateSnapshotService = {
    assertFreshForApprove: jest.fn().mockResolvedValue(undefined),
    buildSnapshot: jest.fn().mockResolvedValue({ tasks: [] }),
  };
  const dispatchCoordinator = {
    dispatch: jest.fn(async (planId: string) => {
      dispatchCalls.push(planId);
    }),
  };
  const feedbackService = {
    recordAcceptance: jest.fn().mockResolvedValue(undefined),
    recordBaseline: jest.fn(),
  };
  const constraintLoaderService = {
    loadForPlan: jest.fn().mockResolvedValue([]),
    hashConstraints: jest.fn().mockReturnValue('h'),
  };
  const outboxService = { enqueue: jest.fn().mockResolvedValue({ id: 'e' }) };
  const simulationService = { run: jest.fn() };
  const service = new PlanService(
    db,
    requestDatabaseContext as never,
    auditService as never,
    undefined as never,
    worldStateSnapshotService as never,
    dispatchCoordinator as never,
    undefined as never,
    feedbackService as never,
    constraintLoaderService as never,
    outboxService as never,
    undefined as never,
    simulationService as never,
  );
  return { service, updatePatches, insertedPlans, dispatchCalls, capturedConditions };
}

describe('PlanService 方案行租户守卫（ADR-071）', () => {
  it('getPlan 跨租户 → NotFound（与不存在同语义）', async () => {
    const { service } = makePlanService(makePlanRow({ orgId: 'ORG-1' }));
    await expect(service.getPlan(PLAN_ID, CTX_ORG2)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getPlan 同租户 → 放行且读模型透出 orgId', async () => {
    const { service } = makePlanService(makePlanRow({ orgId: 'ORG-1' }));
    const plan = await service.getPlan(PLAN_ID, CTX_ORG1);
    expect(plan.planId).toBe(PLAN_ID);
    expect(plan.orgId).toBe('ORG-1');
  });

  it('getPlan 无 actor（内部可信流）→ 放行', async () => {
    const { service } = makePlanService(makePlanRow({ orgId: 'ORG-1' }));
    await expect(service.getPlan(PLAN_ID)).resolves.toMatchObject({ planId: PLAN_ID });
  });

  it('getPlan NULL orgId 存量行 + actor → 放行（standalone_025 过渡边界）', async () => {
    const { service } = makePlanService(makePlanRow({ orgId: null }));
    await expect(service.getPlan(PLAN_ID, CTX_ORG2)).resolves.toMatchObject({ planId: PLAN_ID });
  });

  it('approvePlan 跨租户 → NotFound 且零状态变更', async () => {
    const { service, updatePatches } = makePlanService(
      makePlanRow({ orgId: 'ORG-1', version: 1, status: 'proposed' }),
    );
    await expect(
      service.approvePlan(
        PLAN_ID,
        { version: 1, snapshotVersion: 'WS-1', operator: 'op', reason: 'r' },
        CTX_ORG2,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(updatePatches).toEqual([]);
  });

  it('rejectPlan 跨租户 → NotFound 且零状态变更', async () => {
    const { service, updatePatches } = makePlanService(
      makePlanRow({ orgId: 'ORG-1', version: 1 }),
    );
    await expect(
      service.rejectPlan(PLAN_ID, { operator: 'op', reason: 'r' }, CTX_ORG2),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(updatePatches).toEqual([]);
  });

  it('dispatchPlan 跨租户 → NotFound 且不触碰 DispatchCoordinator', async () => {
    const { service, dispatchCalls } = makePlanService(
      makePlanRow({ orgId: 'ORG-1', isShadow: false }),
    );
    await expect(service.dispatchPlan(PLAN_ID, CTX_ORG2)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(dispatchCalls).toEqual([]);
  });

  it('replan 跨租户 → NotFound（守卫先于快照构建）', async () => {
    const { service } = makePlanService(makePlanRow({ orgId: 'ORG-1', version: 1 }));
    await expect(
      service.replan(PLAN_ID, { lockedConstraints: [] }, CTX_ORG2),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('persistPlan 写 orgId=primaryOrgId（写侧归属闭环）', async () => {
    const { service, insertedPlans } = makePlanService(makePlanRow());
    await service.persistPlan(makePlan(), CTX_ORG1);
    expect(insertedPlans[0].orgId).toBe('ORG-1');
  });
});

// ===== SchedulerQueryService org 条件注入 =====

/** 递归展开 drizzle SQL 对象为可断言文本（queryChunks → 列名/字面量）。 */
function flattenSQL(node: unknown): string {
  if (node == null) return '';
  if (Array.isArray(node)) return node.map(flattenSQL).join(' ');
  if (typeof node !== 'object') return String(node);
  const obj = node as Record<string, unknown>;
  if ('value' in obj) return String(obj.value);
  if ('queryChunks' in obj) {
    return ((obj.queryChunks as unknown[]) ?? []).map(flattenSQL).join(' ');
  }
  return '';
}

/** 深度搜索 SQL 树中是否引用了目标列实例（drizzle Column 对象不参与文本展开）。 */
function containsNode(node: unknown, target: unknown): boolean {
  if (node === target) return true;
  if (Array.isArray(node)) return node.some((n) => containsNode(n, target));
  if (node && typeof node === 'object' && 'queryChunks' in (node as object)) {
    return containsNode((node as { queryChunks: unknown }).queryChunks, target);
  }
  return false;
}

function createQueryDb(runRows: Array<Record<string, unknown>> = []) {
  const captured: Array<unknown> = [];
  const db = {
    select: jest.fn(() => ({
      from: jest.fn((_t: unknown) => ({
        where: jest.fn((cond: unknown) => {
          captured.push(cond);
          const orderBy = jest.fn(() => {
            const limit = jest.fn().mockResolvedValue([]);
            const thenable: Promise<unknown[]> & { limit: jest.Mock } = Promise.resolve(
              [],
            ) as Promise<unknown[]> & { limit: jest.Mock };
            thenable.limit = limit;
            return thenable;
          });
          return { orderBy, limit: jest.fn().mockResolvedValue(runRows) };
        }),
      })),
    })),
  };
  return { db, captured };
}

function makeQueryService(db: unknown) {
  const planService = {
    listPlansBatched: jest.fn().mockResolvedValue([]),
    getPlan: jest.fn(),
  };
  return new SchedulerQueryService(
    db as never,
    undefined as never,
    planService as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );
}

describe('SchedulerQueryService getPlans/getActivePlans org 条件（ADR-071）', () => {
  it('getPlans 无 actor → 无 org 条件（内部可信流，RLS 兜底）', async () => {
    const { db, captured } = createQueryDb();
    const service = makeQueryService(db);
    await service.getPlans(undefined);
    expect(captured[0]).toBeUndefined();
  });

  it('getPlans 有 actor → SQL 含 org_id 过滤（本租户 + NULL 存量）', async () => {
    const { db, captured } = createQueryDb();
    const service = makeQueryService(db);
    await service.getPlans('proposed', CTX_ORG2);
    expect(containsNode(captured[0], ewohSchedulePlan.orgId)).toBe(true);
    const sqlText = flattenSQL(captured[0]);
    expect(sqlText).toContain('is null');
    expect(sqlText).toContain('ORG-2');
  });

  it('getActivePlans 有 actor → SQL 含 org_id 过滤；无 actor → 仅状态条件', async () => {
    const { db, captured } = createQueryDb();
    const service = makeQueryService(db);
    await service.getActivePlans(CTX_ORG2);
    expect(containsNode(captured[0], ewohSchedulePlan.orgId)).toBe(true);
    expect(flattenSQL(captured[0])).toContain('ORG-2');

    await service.getActivePlans();
    expect(containsNode(captured[1], ewohSchedulePlan.orgId)).toBe(false);
    expect(containsNode(captured[1], ewohSchedulePlan.status)).toBe(true);
  });
});

describe('assertTenantVisible 通用守卫（ADR-072）', () => {
  it('org 匹配 / NULL 存量 / actor 缺失 → 放行；跨租户 → NotFound（对象标签反枚举）', () => {
    expect(() => assertTenantVisible('ORG-1', CTX_ORG1, 'Run RUN-1')).not.toThrow();
    expect(() => assertTenantVisible(null, CTX_ORG2, 'Run RUN-1')).not.toThrow();
    expect(() => assertTenantVisible('ORG-1', undefined)).not.toThrow();
    let thrown: unknown;
    try {
      assertTenantVisible('ORG-1', CTX_ORG2, 'Run RUN-1');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect((thrown as Error).message).toContain('RUN-1');
  });
});

describe('SchedulerQueryService getRun 租户守卫（ADR-072）', () => {
  it('跨租户 → NotFound（与不存在同语义）', async () => {
    const { db } = createQueryDb([{ runId: 'RUN-1', orgId: 'ORG-1' }]);
    const service = makeQueryService(db);
    await expect(service.getRun('RUN-1', CTX_ORG2)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('同租户 → 返回 run；NULL 存量行 + actor → 放行（standalone_025 过渡边界）', async () => {
    const { db } = createQueryDb([{ runId: 'RUN-1', orgId: 'ORG-1' }]);
    const service = makeQueryService(db);
    const run = await service.getRun('RUN-1', CTX_ORG1);
    expect(run?.runId).toBe('RUN-1');

    const { db: db2 } = createQueryDb([{ runId: 'RUN-2', orgId: null }]);
    const svc2 = makeQueryService(db2);
    const legacy = await svc2.getRun('RUN-2', CTX_ORG2);
    expect(legacy?.runId).toBe('RUN-2');
  });

  it('无 actor（内部可信流）→ 放行', async () => {
    const { db } = createQueryDb([{ runId: 'RUN-1', orgId: 'ORG-1' }]);
    const service = makeQueryService(db);
    const run = await service.getRun('RUN-1');
    expect(run?.runId).toBe('RUN-1');
  });
});

describe('SchedulerQueryService getAudit 父方案归属过滤（ADR-072）', () => {
  it('无 actor → 无 org 条件（现状兼容）', async () => {
    const { db, captured } = createQueryDb();
    const service = makeQueryService(db);
    await service.getAudit(undefined);
    expect(captured[0]).toBeUndefined();
  });

  it('有 actor → SQL 含父方案 org 子查询条件（plan.org_id 节点 + 本租户）', async () => {
    const { db, captured } = createQueryDb();
    const service = makeQueryService(db);
    await service.getAudit(undefined, CTX_ORG2);
    const cond = captured[0];
    expect(containsNode(cond, ewohSchedulePlan.orgId)).toBe(true);
    expect(flattenSQL(cond)).toContain('ORG-2');
  });

  it('指定 planId 且无 actor → 仅 planId 条件（内部可信流）', async () => {
    const { db, captured } = createQueryDb();
    const service = makeQueryService(db);
    await service.getAudit('P-1');
    expect(containsNode(captured[0], ewohSchedulePlan.orgId)).toBe(false);
    expect(flattenSQL(captured[0])).toContain('P-1');
  });
});

describe('PlanService listPlanConstraints org 条件（ADR-072）', () => {
  it('有 actor → 约束查询含 org 条件（org 匹配或 NULL 存量）', async () => {
    const { service, capturedConditions } = makePlanService(makePlanRow());
    await service.listPlanConstraints('PLAN-X', CTX_ORG2);
    const constraintCond = capturedConditions.find((c) => c.table === ewohSchedulingConstraint);
    expect(containsNode(constraintCond?.cond, ewohSchedulingConstraint.orgId)).toBe(true);
    expect(flattenSQL(constraintCond?.cond)).toContain('ORG-2');
  });

  it('无 actor → 约束查询无 org 条件', async () => {
    const { service, capturedConditions } = makePlanService(makePlanRow());
    await service.listPlanConstraints('PLAN-X');
    const constraintCond = capturedConditions.find((c) => c.table === ewohSchedulingConstraint);
    expect(containsNode(constraintCond?.cond, ewohSchedulingConstraint.orgId)).toBe(false);
  });
});
