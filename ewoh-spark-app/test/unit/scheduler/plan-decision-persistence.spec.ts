/* plan-decision-persistence.spec.ts — Decision 契约持久化往返（NO-12y / ADR-048）。
 *
 * persistPlan 唯一投影点：方案落库必带 decisionRecordsJson（或显式缺口
 * decisionProjectionIssues）；getPlan 读回契约形态 DecisionRecord[]。
 * standalone_050 decision_records_json 列（原地加固，计数不变 73/76）。
 */
import { PlanService } from '../../../server/modules/scheduler/plan.service';
import { ewohSchedulePlan, ewohSchedulingPlanAssignment } from '@server/database/schema';
import type { DecisionTrace, SchedulingPlanV2 } from '@shared/scheduler';
import { validateDecision } from '@shared/decision';

const PLAN_ID = 'PLAN-DEC-1';

function makeDecisionTrace(taskId: string): DecisionTrace {
  return {
    taskId,
    selected: { personId: 'person:p1', deviceId: null, stationId: 'station:s1' },
    priority: { level: 'HIGH', score: 88, factors: [] },
    candidates: [
      { personId: 'person:p1', deviceId: null, stationId: 'station:s1', score: 92.5, reasons: ['skill-match'] },
      { personId: 'person:p2', deviceId: null, stationId: 'station:s1', score: 71, reasons: [] },
    ],
    selectedReason: ['skill-match', 'low-fatigue'],
    rejectedAlternatives: [
      { personId: 'person:p2', deviceId: null, stationId: 'station:s1', reason: ['lower-score'] },
    ],
    policyVersion: 8,
    solverVersion: 'heuristic-v2',
    snapshotVersion: 'WS-1',
  };
}

function makePlan(assignments: SchedulingPlanV2['assignments']): SchedulingPlanV2 {
  return {
    planId: PLAN_ID,
    version: 1,
    status: 'shadow',
    trigger: { type: 'MANUAL', entityId: null },
    snapshotVersion: 'WS-1',
    policyVersion: 8,
    solverVersion: 'heuristic-v2',
    horizonMinutes: 480,
    assignments,
    metrics: { lateMinutes: 0, walkingMeters: 0, stationWaitMinutes: 0, maxWorkload: 0, changeCost: 0 },
    baselineDelta: {},
    violations: [],
    createdAt: '2026-08-16T08:00:00Z',
  };
}

function makeAssignmentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assignmentId: 'ASG-DEC-1',
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
    ...overrides,
  };
}

function makePlanService(opts: {
  planRow: Record<string, unknown>;
  assignmentRows: Array<Record<string, unknown>>;
}) {
  const auditLogs: Array<Record<string, unknown>> = [];
  const insertedPlans: Array<Record<string, unknown>> = [];
  const updatePatches: Array<Record<string, unknown>> = [];
  function thenable(data: unknown[]): unknown {
    return {
      then: (resolve: (v: unknown[]) => void) => resolve(data),
      limit: jest.fn(async () => data.slice(0, 10)),
      orderBy: jest.fn(async () => data),
    };
  }
  const db = {
    select: jest.fn((_table: unknown) => ({
      from: jest.fn((table2: unknown) => ({
        where: jest.fn((_cond: unknown) => {
          if (table2 === ewohSchedulePlan) return thenable([opts.planRow]);
          if (table2 === ewohSchedulingPlanAssignment) return thenable(opts.assignmentRows);
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
        if (table === ewohSchedulePlan) {
          insertedPlans.push(row);
          return { returning: jest.fn(async () => [row]) };
        }
        auditLogs.push(row);
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
    appendAuditLog: jest.fn(async (entry: Record<string, unknown>) => {
      auditLogs.push(entry);
    }),
    insertAudit: jest.fn(async (entry: Record<string, unknown>) => {
      auditLogs.push(entry);
    }),
  };
  const worldStateSnapshotService = {
    assertFreshForApprove: jest.fn().mockResolvedValue(undefined),
    buildSnapshot: jest.fn().mockResolvedValue({}),
  };
  const feedbackService = { recordAcceptance: jest.fn().mockResolvedValue(undefined), recordBaseline: jest.fn() };
  const constraintLoaderService = { loadForPlan: jest.fn().mockResolvedValue([]), hashConstraints: jest.fn().mockReturnValue('h') };
  const outboxService = { enqueue: jest.fn().mockResolvedValue({ id: 'e' }) };
  const simulationService = { run: jest.fn() };
  const service = new PlanService(
    db,
    requestDatabaseContext as never,
    auditService as never,
    undefined as never,
    worldStateSnapshotService as never,
    undefined as never,
    undefined as never,
    feedbackService as never,
    constraintLoaderService as never,
    outboxService as never,
    undefined as never,
    simulationService as never,
  );
  return { service, insertedPlans, updatePatches };
}

const CTX = { userId: 'tester', primaryOrgId: 'ORG-1' } as never;

describe('PlanService Decision 契约持久化往返（ADR-048 / standalone_050）', () => {
  it('persistPlan 唯一投影点：决策记录随方案落库（契约校验通过）且 plan 携带 records', async () => {
    const assignment = {
      assignmentId: 'ASG-DEC-1',
      taskId: 'task:t-1001',
      personId: 'person:p1',
      deviceId: null,
      stationId: 'station:s1',
      zoneId: null,
      plannedStart: '2026-08-16T08:00:00Z',
      plannedEnd: '2026-08-16T08:30:00Z',
      routeId: null,
      status: 'proposed' as const,
      riskLevel: 'medium',
      reasons: ['skill-match'],
      alternatives: [],
      decisionTrace: makeDecisionTrace('task:t-1001'),
    };
    const ctx = makePlanService({
      planRow: { planId: PLAN_ID },
      assignmentRows: [makeAssignmentRow()],
    });
    const plan = makePlan([assignment]);
    await ctx.service.persistPlan(plan, CTX);

    expect(plan.decisionRecords).toHaveLength(1);
    expect(plan.decisionProjectionIssues).toEqual([]);
    const record = plan.decisionRecords?.[0];
    expect(record?.decisionId).toBe(`decision:${PLAN_ID}:task:t-1001`);
    expect(record?.riskLevel).toBe('medium');
    expect(validateDecision(record)).toEqual([]);

    const inserted = ctx.insertedPlans[0];
    expect(inserted.decisionRecordsJson).toHaveLength(1);
    expect((inserted.decisionRecordsJson as Array<Record<string, unknown>>)[0].decisionId)
      .toBe(`decision:${PLAN_ID}:task:t-1001`);
  });

  it('getPlan 读回契约形态 decisionRecords（NULL=存量未投影行 → undefined）', async () => {
    const stored = {
      decisionId: 'decision:PLAN-DEC-1:task:t-1001',
      kind: 'task_assignment',
      status: 'proposed',
      decisionAuthority: 'optimization',
      subject: 'task:task:t-1001',
      tenantId: 'ORG-1',
      riskLevel: 'medium',
      requiresApproval: true,
      decidedAt: '2026-08-16T08:00:00.000Z',
      selected: { optionId: 'opt:person:p1:none:station:s1', reason: ['skill-match'] },
      auditTrail: [{ actor: 'solver:heuristic-v2', action: 'decided', at: '2026-08-16T08:00:00.000Z' }],
    };
    const planRow = {
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
      decisionRecordsJson: [stored],
      orgId: 'ORG-1',
      isShadow: false,
      createdAt: new Date('2026-08-16T08:00:00Z'),
      updatedAt: new Date(),
    };
    const ctx = makePlanService({ planRow, assignmentRows: [makeAssignmentRow()] });
    const result = await ctx.service.getPlan(PLAN_ID);
    expect(result.decisionRecords).toEqual([stored]);
  });

  it('缺口显式：无 trace 的 assignment → decisionProjectionIssues 计数 + 列写 NULL（绝不伪造）', async () => {
    const assignment = {
      assignmentId: 'ASG-DEC-2',
      taskId: 'task:t-2',
      personId: 'person:p2',
      deviceId: null,
      stationId: null,
      zoneId: null,
      plannedStart: null,
      plannedEnd: null,
      routeId: null,
      status: 'proposed' as const,
      reasons: [],
      alternatives: [],
      decisionTrace: undefined,
    };
    const ctx = makePlanService({
      planRow: { planId: PLAN_ID },
      assignmentRows: [makeAssignmentRow()],
    });
    const plan = makePlan([assignment]);
    await ctx.service.persistPlan(plan, CTX);
    expect(plan.decisionRecords).toEqual([]);
    expect(plan.decisionProjectionIssues).toEqual([{ assignmentId: 'ASG-DEC-2', reason: 'decision_no_trace' }]);
    expect(ctx.insertedPlans[0].decisionRecordsJson).toBeNull();
  });
});

describe('PlanService plan_approval 决策台账追加（NO-13h / ADR-057）', () => {
  it('approvePlan：追加 plan_approval 决策记录（契约形态，既有记录保留）', async () => {
    const ctx = makePlanService({
      planRow: {
        planId: PLAN_ID,
        version: 1,
        isShadow: false,
        decisionRecordsJson: [{ decisionId: 'decision:PLAN-DEC-1:task:t-1001', kind: 'task_assignment' }],
      },
      assignmentRows: [makeAssignmentRow()],
    });
    await ctx.service.approvePlan(
      PLAN_ID,
      { version: 1, snapshotVersion: 'WS-1', operator: 'tester', reason: '验证通过' },
      CTX,
    );
    const patch = ctx.updatePatches.find((p) => p.decisionRecordsJson != null);
    expect(patch).toBeDefined();
    const records = patch?.decisionRecordsJson as Array<Record<string, unknown>>;
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      kind: 'plan_approval',
      status: 'approved',
      decisionId: `decision:${PLAN_ID}:approval:v1`,
      decisionAuthority: 'human',
      riskLevel: 'high',
    });
  });

  it('rejectPlan：追加 rejected 决策（selected=opt:reject）', async () => {
    const ctx = makePlanService({
      planRow: { planId: PLAN_ID, version: 1, isShadow: false, decisionRecordsJson: [] },
      assignmentRows: [makeAssignmentRow()],
    });
    await ctx.service.rejectPlan(PLAN_ID, { operator: 'tester', reason: '冲突过多' }, CTX);
    const patch = ctx.updatePatches.find((p) => p.decisionRecordsJson != null);
    const records = patch?.decisionRecordsJson as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'plan_approval',
      status: 'rejected',
      decisionId: `decision:${PLAN_ID}:approval:v1`,
    });
  });
});
