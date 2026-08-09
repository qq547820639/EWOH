import { ConflictException } from '@nestjs/common';
import { SchedulerService } from '../../../server/modules/scheduler/scheduler.service';
import { ewohScheduleAudit } from '@server/database/schema';

function sqlContains(
  condition: unknown,
  column: string,
  value: string,
): boolean {
  const strings: string[] = [];
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (node === null || node === undefined || typeof node !== 'object') {
      if (typeof node === 'string') strings.push(node);
      return;
    }
    if (seen.has(node)) return;
    seen.add(node);
    for (const child of Object.values(node)) visit(child);
  };
  visit(condition);
  return strings.includes(column) && strings.includes(value);
}

function createSchedulerDb(
  planRows: unknown[],
  updateRows: unknown[],
  auditRows: unknown[],
) {
  const updateReturning = jest.fn().mockResolvedValue(updateRows);
  const updateWhere = jest.fn((_condition: unknown) => ({
    returning: updateReturning,
  }));
  const insertReturning = jest.fn().mockResolvedValue(auditRows);
  const selectLimit = jest.fn().mockResolvedValue(planRows);
  return {
    db: {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({ limit: selectLimit })),
        })),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: updateWhere,
        })),
      })),
      insert: jest.fn(() => ({
        values: jest.fn(() => ({
          returning: insertReturning,
        })),
      })),
    } as never,
    updateWhere,
    insertReturning,
    updateReturning,
  };
}

const ACTOR = { userId: 'user-1', primaryOrgId: 'org-1' };

describe('SchedulerService confirmPlan', () => {
  it('returns 409 STATE_CONFLICT when the conditional update affects zero rows', async () => {
    const plan = { id: 'row-1', planId: 'P-1', status: 'shadow' };
    const { db, updateWhere } = createSchedulerDb([plan], [], []);
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const context = {
      runInTransaction: jest.fn(
        async (_settings: unknown, operation: () => Promise<unknown>) =>
          operation(),
      ),
    };
    const service = new SchedulerService(
      db,
      context as never,
      audit as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

    const error = await service
      .confirmPlan('P-1', 'ok', 'supervisor', ACTOR)
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.status).toBe(409);
    expect(error.message).toContain('STATE_CONFLICT');
    expect(sqlContains(updateWhere.mock.calls[0][0], 'status', 'shadow')).toBe(
      true,
    );
    expect(audit.appendAuditLog).not.toHaveBeenCalled();
  });

  it('confirms and audits inside the same request transaction', async () => {
    const plan = {
      id: 'row-1',
      planId: 'P-1',
      planName: 'plan',
      strategy: 'keep_status',
      status: 'shadow',
      taktImprovement: 0,
      highLoadPersons: 0,
      lowBatteryRisk: 0,
      affectedPersons: 0,
      metricsJson: null,
      reason: null,
      createdAt: new Date(),
      confirmedBy: null,
      confirmedAt: null,
      confirmReason: null,
    };
    const updated = {
      ...plan,
      status: 'confirmed',
      confirmedBy: 'supervisor',
      confirmedAt: new Date(),
      confirmReason: 'ok',
    };
    const auditRow = {
      id: 'audit-row',
      auditId: 'AUDIT-1',
      planId: 'P-1',
      action: 'confirm',
      operator: 'supervisor',
      reason: 'ok',
      createdAt: new Date(),
    };
    const { db, insertReturning } = createSchedulerDb(
      [plan],
      [updated],
      [auditRow],
    );
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    let insideTransaction = false;
    const context = {
      runInTransaction: jest.fn(
        async (_settings: unknown, operation: () => Promise<unknown>) => {
          insideTransaction = true;
          try {
            return await operation();
          } finally {
            insideTransaction = false;
          }
        },
      ),
    };
    const service = new SchedulerService(
      db,
      context as never,
      audit as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

    let insertSawTransaction = false;
    insertReturning.mockImplementation(async () => {
      insertSawTransaction = insideTransaction;
      return [auditRow];
    });
    let auditSawTransaction = false;
    audit.appendAuditLog.mockImplementation(async () => {
      auditSawTransaction = insideTransaction;
    });

    const result = await service.confirmPlan('P-1', 'ok', 'supervisor', ACTOR);

    expect(result.plan.status).toBe('confirmed');
    expect(context.runInTransaction).toHaveBeenCalledWith(
      expect.arrayContaining([
        { name: 'app.user_id', value: 'user-1' },
        { name: 'app.current_org_id', value: 'org-1' },
      ]),
      expect.any(Function),
    );
    expect(insertSawTransaction).toBe(true);
    expect(auditSawTransaction).toBe(true);
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        orgId: 'org-1',
        action: 'scheduler.confirm',
        entityType: 'schedule_plan',
        entityId: 'P-1',
        before: { status: 'shadow', confirmReason: null },
        after: expect.objectContaining({ status: 'confirmed' }),
      }),
    );
  });
});

describe('SchedulerService generatePlans（P1-SSOT：委托 V2 createRun，不再合成方案）', () => {
  it('委托真实调度链路并映射为 legacy 形状（metricsJson 只含真实 solver 指标）', async () => {
    const db = {
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn().mockResolvedValue(undefined),
        })),
      })),
    } as never;
    const context = {
      runInTransaction: jest.fn(
        async (_settings: unknown, operation: () => Promise<unknown>) =>
          operation(),
      ),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const triggerService = {
      evaluate: jest.fn().mockResolvedValue({
        runId: 'RUN-1',
        triggerType: 'MANUAL',
        triggerEntityId: null,
        status: 'queued',
      }),
    };
    const worldState = {
      buildSnapshot: jest.fn().mockResolvedValue({ snapshotVersion: 'WS-1' }),
    };
    const solver = {
      solveVariants: jest.fn().mockResolvedValue([
        {
          planId: 'RUN-1A',
          planName: '准时优先',
          status: 'shadow',
          solverVersion: 'heuristic-v2',
          solverStatus: 'HEURISTIC',
          solveDurationMs: 5,
          fallbackReason: 'cp-sat unavailable',
          objective: 0,
          objectiveBreakdown: null,
          assignments: [],
          baselineDelta: null,
          violations: [],
          createdAt: '2026-01-01',
        },
      ]),
    };
    const planService = {
      persistPlan: jest.fn().mockResolvedValue(undefined),
    };
    const service = new SchedulerService(
      db,
      context as never,
      audit as never,
      worldState as never, // worldStateSnapshotService
      triggerService as never,
      solver as never,
      planService as never,
      {} as never, // routingService
      {} as never, // eligibilityService
      {} as never, // routeCostProvider
      {} as never, // policyService
      {} as never, // feedbackService
    );

    const result = await service.generatePlans({});

    expect(triggerService.evaluate).toHaveBeenCalledWith('MANUAL', null, expect.anything());
    expect(solver.solveVariants).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0].planId).toBe('RUN-1A');
    // 真实 solver 指标透传（不伪造 taktImprovement 等演示指标）。
    expect(result[0].taktImprovement).toBe(0);
    expect(result[0].metricsJson).toMatchObject({
      solverStatus: 'HEURISTIC',
      fallbackReason: 'cp-sat unavailable',
    });
    expect(result[0].affectedPersons).toBe(0);
  });
});

describe('SchedulerService weights 契约（P1-SSOT：内存权重已移除）', () => {
  it('updateWeights / getWeights 已从服务移除（正式策略只走版本化 SchedulingPolicy）', () => {
    // P1-SSOT：删除 in-memory weights 双系统后，服务不应再暴露这些方法。
    // 直接断言类原型：updateWeights/getWeights 已被删除（P1-SSOT）。
    const proto = SchedulerService.prototype as unknown as Record<string, unknown>;
    expect(proto.updateWeights).toBeUndefined();
    expect(proto.getWeights).toBeUndefined();
    expect(proto.getDataDrivenPlans).toBeUndefined();
  });
});
