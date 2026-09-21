/* plan-pre-approval-simulation.spec.ts — 审批前自动布局仿真预验证（NO-12s / ADR-042）。 */
import { PlanService } from '../../../server/modules/scheduler/plan.service';
import { ewohSchedulePlan, ewohSchedulingPlanAssignment, ewohSimulationRun } from '@server/database/schema';

const PLAN_ID = 'PLAN-1';

function makePlanRow() {
  return {
    id: 'id-1',
    planId: PLAN_ID,
    planName: 'plan-a',
    strategy: 'scheduling_v2',
    status: 'proposed',
    version: 1,
    snapshotVersion: 'WS-1',
    triggerType: 'MANUAL',
    triggerEntityId: null,
    metricsJson: { lateMinutes: 0, walkingMeters: 0, stationWaitMinutes: 0, maxWorkload: 0, changeCost: 0 },
    baselineDeltaJson: {},
    violationsJson: [],
    constraintsJson: [],
    policyVersion: 1,
    solverVersion: 'heuristic-v2',
    horizonMinutes: 480,
    scoreBreakdownJson: null,
    weightsJson: null,
    isShadow: false,
    shadowPolicyVersion: null,
    isSimulation: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeAssignmentRow(overrides: Record<string, unknown> = {}) {
  return {
    assignmentId: 'ASG-1',
    planId: PLAN_ID,
    taskId: 'TASK-1',
    personId: 'P-1',
    deviceId: null,
    stationId: 'ST-1',
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
  assignmentRows: Array<Record<string, unknown>>;
  simulationRun: jest.Mock;
  simulationError?: Error;
}) {
  const auditLogs: Array<Record<string, unknown>> = [];
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
          if (table2 === ewohSchedulePlan) return thenable([makePlanRow()]);
          if (table2 === ewohSchedulingPlanAssignment) return thenable(opts.assignmentRows);
          if (table2 === ewohSimulationRun) return thenable([]);
          return thenable([]);
        }),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn(() => ({
          returning: jest.fn(async () => [{ id: 'updated' }]),
        })),
      })),
    })),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((row: Record<string, unknown>) => {
        if (table === ewohSchedulePlan || table === ewohSchedulingPlanAssignment) {
          return { returning: jest.fn(async () => [row]) };
        }
        auditLogs.push(row); // ewohScheduleAudit 等审计行捕获
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
    // 分波次派工新增协作方法：替身必须同形实现，否则波次派工路径不可测。
    assertFreshForWave: jest.fn().mockResolvedValue(undefined),
    buildSnapshot: jest.fn().mockResolvedValue({
      snapshotVersion: 'WS-1',
      ts: new Date().toISOString(),
      worldVersion: 1,
      entityVersions: {},
      reservations: [],
      persons: [],
      tasks: [],
      devices: [],
      stations: [
        { id: 'ST-1', name: 'ST-1', x: 0, y: 0 },
        { id: 'ST-2', name: 'ST-2', x: 30, y: 40 },
      ],
      backlog: [],
      events: [],
    }),
  };
  const feedbackService = { recordAcceptance: jest.fn().mockResolvedValue(undefined), recordBaseline: jest.fn() };
  const constraintLoaderService = { loadForPlan: jest.fn().mockResolvedValue([]), hashConstraints: jest.fn().mockReturnValue('h') };
  const outboxService = { enqueue: jest.fn().mockResolvedValue({ id: 'e' }) };
  const simulationService = {
    run: opts.simulationRun,
  };
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
  return { service, auditService, auditLogs, simulationService, worldStateSnapshotService };
}

const CTX = { userId: 'tester', primaryOrgId: 'ORG-1' } as never;

describe('PlanService 审批前自动布局仿真预验证（ADR-042）', () => {
  it('多工位移动链 → 自动运行 layout 仿真（确定性 runId/scenarioId）并审计留痕', async () => {
    const simulationRun = jest.fn().mockResolvedValue({
      run: {
        runId: `plan-approval:${PLAN_ID}`,
        kind: 'layout',
        status: 'completed',
        engineVersion: '1.0.0',
        results: { totalTravelDistance: 50, routes: [{}, {}] },
      },
      created: true,
    });
    const ctx = makePlanService({
      assignmentRows: [
        makeAssignmentRow({ assignmentId: 'ASG-1', personId: 'P-1', stationId: 'ST-1', plannedStart: new Date('2026-08-16T08:00:00Z') }),
        makeAssignmentRow({ assignmentId: 'ASG-2', personId: 'P-1', stationId: 'ST-2', plannedStart: new Date('2026-08-16T09:00:00Z') }),
      ],
      simulationRun,
    });
    const result = await ctx.service.approvePlan(
      PLAN_ID,
      { version: 1, snapshotVersion: 'WS-1', operator: 'tester', reason: '验证' },
      CTX,
    );
    expect(result.planId).toBe(PLAN_ID);
    expect(simulationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: `plan-approval:${PLAN_ID}`,
        kind: 'layout',
        baseRef: { snapshotVersion: 0, scenarioId: `plan:${PLAN_ID}` },
        parameters: expect.objectContaining({
          moves: [{ fromStationId: 'ST-1', toStationId: 'ST-2', trips: 1 }],
        }),
      }),
      'ORG-1',
    );
    const audit = ctx.auditLogs.find((entry) => entry.action === 'scheduler.plan.approve');
    expect(audit?.after).toEqual({
      status: 'approved',
      preApprovalSimulation: expect.objectContaining({
        runId: `plan-approval:${PLAN_ID}`,
        status: 'completed',
        totalTravelDistanceM: 50,
        routesCount: 2,
      }),
    });
  });

  it('无多工位移动链 → 显式 skip 留痕（不运行仿真、不阻断审批）', async () => {
    const simulationRun = jest.fn();
    const ctx = makePlanService({
      assignmentRows: [
        makeAssignmentRow({ assignmentId: 'ASG-1', personId: 'P-1', stationId: 'ST-1', plannedStart: new Date('2026-08-16T08:00:00Z') }),
      ],
      simulationRun,
    });
    const result = await ctx.service.approvePlan(
      PLAN_ID,
      { version: 1, snapshotVersion: 'WS-1', operator: 'tester' },
      CTX,
    );
    expect(result.planId).toBe(PLAN_ID);
    expect(simulationRun).not.toHaveBeenCalled();
    const audit = ctx.auditLogs.find((entry) => entry.action === 'scheduler.plan.approve');
    expect(audit?.after).toEqual({
      status: 'approved',
      preApprovalSimulation: expect.objectContaining({
        status: 'skipped',
        skippedReason: 'no_multi_station_route',
      }),
    });
  });

  it('仿真失败 → 显式 error 留痕，审批照常通过（advisory 不阻断）', async () => {
    const simulationRun = jest.fn().mockRejectedValue(new Error('simulation_boom'));
    const ctx = makePlanService({
      assignmentRows: [
        makeAssignmentRow({ assignmentId: 'ASG-1', personId: 'P-1', stationId: 'ST-1', plannedStart: new Date('2026-08-16T08:00:00Z') }),
        makeAssignmentRow({ assignmentId: 'ASG-2', personId: 'P-1', stationId: 'ST-2', plannedStart: new Date('2026-08-16T09:00:00Z') }),
      ],
      simulationRun,
    });
    const result = await ctx.service.approvePlan(
      PLAN_ID,
      { version: 1, snapshotVersion: 'WS-1', operator: 'tester' },
      CTX,
    );
    expect(result.planId).toBe(PLAN_ID);
    const audit = ctx.auditLogs.find((entry) => entry.action === 'scheduler.plan.approve');
    expect(audit?.after).toEqual({
      status: 'approved',
      preApprovalSimulation: expect.objectContaining({
        status: 'failed',
        error: 'simulation_boom',
      }),
    });
  });
});
