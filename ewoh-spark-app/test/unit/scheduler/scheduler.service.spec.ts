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

describe('SchedulerService generatePlans idempotency', () => {
  it('returns existing plans when the same idempotency key is reused', async () => {
    const plan = {
      id: 'row-1',
      planId: 'PLAN-key-1-KEEP',
      planName: '保持现状',
      strategy: 'keep_status',
      status: 'shadow',
      taktImprovement: 0,
      highLoadPersons: 1,
      lowBatteryRisk: 0,
      affectedPersons: 0,
      metricsJson: null,
      reason: 'existing',
      createdAt: new Date(),
      confirmedBy: null,
      confirmedAt: null,
      confirmReason: null,
    };
    const where = jest.fn().mockResolvedValue([plan]);
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where })),
      })),
    } as never;
    const context = {
      runInTransaction: jest.fn(
        async (_settings: unknown, operation: () => Promise<unknown>) =>
          operation(),
      ),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new SchedulerService(
      db,
      context as never,
      audit as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

    const result = await service.generatePlans({ idempotencyKey: 'key-1' });

    expect(result).toHaveLength(1);
    expect(result[0].planId).toBe('PLAN-key-1-KEEP');
    expect(where).toHaveBeenCalledTimes(1);
  });
});

describe('SchedulerService updateWeights', () => {
  const NEW_WEIGHTS = {
    w1_output: 0.4,
    w2_on_time: 0.2,
    w3_safety_risk: 0.15,
    w4_body_load: 0.15,
    w5_move_distance: 0.05,
    w6_changeover_cost: 0.05,
  };

  it('persists weights.update to ewoh_schedule_audit and audit log inside the request transaction', async () => {
    let insideTransaction = false;
    let capturedRow: Record<string, unknown> | undefined;
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
    let insertSawTransaction = false;
    const insert = jest.fn((_table: unknown) => ({
      values: jest.fn(async (row: unknown) => {
        insertSawTransaction = insideTransaction;
        capturedRow = row as Record<string, unknown>;
      }),
    }));
    const db = { insert } as never;
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new SchedulerService(
      db,
      context as never,
      audit as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

    const result = await service.updateWeights(
      NEW_WEIGHTS,
      'body-operator',
      'tuning',
      ACTOR,
    );

    expect(result).toEqual(NEW_WEIGHTS);
    expect(insertSawTransaction).toBe(true);
    expect(capturedRow).toMatchObject({
      planId: 'weights',
      action: 'weights.update',
      operator: 'user-1',
    });
    expect(insert.mock.calls[0][0]).toBe(ewohScheduleAudit);
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        orgId: 'org-1',
        action: 'scheduler.weights.update',
        entityType: 'schedule_weights',
        entityId: 'weights',
        before: expect.objectContaining({ w1_output: 0.25 }),
        after: NEW_WEIGHTS,
      }),
    );
  });

  it('keeps the API response shape and does not update memory when the transaction fails', async () => {
    const context = {
      runInTransaction: jest.fn(
        async (_settings: unknown, operation: () => Promise<unknown>) =>
          operation(),
      ),
    };
    const insert = jest.fn((_table: unknown) => ({
      values: jest.fn().mockResolvedValue(undefined),
    }));
    const audit = {
      appendAuditLog: jest.fn().mockRejectedValue(new Error('audit store down')),
    };
    const service = new SchedulerService(
      { insert } as never,
      context as never,
      audit as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    const before = service.getWeights();

    await expect(
      service.updateWeights(NEW_WEIGHTS, undefined, undefined, ACTOR),
    ).rejects.toThrow('audit store down');

    expect(service.getWeights()).toEqual(before);
  });
});
