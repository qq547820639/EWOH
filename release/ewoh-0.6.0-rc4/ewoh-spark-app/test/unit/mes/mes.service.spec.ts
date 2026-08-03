import {
  MesService,
  nextStepStatus,
  nextWorkOrderStatus,
} from '../../../server/modules/mes/mes.service';
import {
  ewohEvent,
  ewohScheduleTask,
  ewohScheduleTaskStep,
} from '@server/database/schema';

function createGetDb(
  workOrderRows: unknown[],
  stepRows: unknown[],
  materialRows: unknown[],
) {
  const whereWorkOrder = jest.fn().mockResolvedValue(workOrderRows);
  const whereSteps = jest.fn(() => ({
    orderBy: jest.fn().mockResolvedValue(stepRows),
  }));
  const whereMaterials = jest.fn(() => ({
    orderBy: jest.fn().mockResolvedValue(materialRows),
  }));
  return {
    db: {
      select: jest.fn(() => ({
        from: jest.fn((table: unknown) => {
          if (table === ewohScheduleTask) {
            return { where: whereWorkOrder };
          }
          if (table === ewohScheduleTaskStep) {
            return { where: whereSteps };
          }
          return { where: whereMaterials };
        }),
      })),
    },
    whereWorkOrder,
  };
}

describe('MES state machines', () => {
  it('walks the work order happy path', () => {
    let status = 'draft';
    for (const action of ['release', 'start', 'complete']) {
      status = nextWorkOrderStatus(status, action)!;
      expect(status).not.toBeNull();
    }
    expect(status).toBe('completed');
  });

  it('walks the step happy path', () => {
    let status = 'pending';
    for (const action of ['start', 'report', 'review', 'handover']) {
      status = nextStepStatus(status, action)!;
      expect(status).not.toBeNull();
    }
    expect(status).toBe('handed_over');
  });

  it('rejects illegal transitions', () => {
    expect(nextWorkOrderStatus('draft', 'complete')).toBeNull();
    expect(nextStepStatus('pending', 'handover')).toBeNull();
    expect(nextWorkOrderStatus('completed', 'cancel')).toBeNull();
  });
});

describe('MesService work order creation', () => {
  it('creates a work order and its steps with audit', async () => {
    const scheduleRow = {
      scheduleTaskId: 'WO-1',
      title: '装配工单',
      status: 'draft',
    };
    const returning = jest.fn().mockResolvedValue([scheduleRow]);
    const insertEntries: Array<{ table: unknown; rows: unknown }> = [];
    const insert = jest.fn((table: unknown) => ({
      values: jest.fn((rows: unknown) => {
        insertEntries.push({ table, rows });
        return { returning };
      }),
    }));
    const { db } = createGetDb([scheduleRow], [], []);
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new MesService(
      { ...db, insert } as never,
      audit as never,
    );

    const result = await service.createWorkOrder(
      {
        orderId: 'WO-1',
        title: '装配工单',
        productCode: 'P-001',
        orderQty: 10,
        steps: [{ name: '上料' }, { name: '装配' }],
      },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );

    expect(result.workOrder.scheduleTaskId).toBe('WO-1');
    expect(insert).toHaveBeenCalledTimes(2);
    expect(insertEntries[0].table).toBe(ewohScheduleTask);
    expect(insertEntries[1].table).toBe(ewohScheduleTaskStep);
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        orgId: 'org-1',
        action: 'mes.work_order.create',
        entityId: 'WO-1',
      }),
    );
  });
});

describe('MesService work order transition', () => {
  it('completes only after all steps are handed over', async () => {
    const workOrder = {
      scheduleTaskId: 'WO-1',
      title: '装配',
      status: 'in_progress',
      progress: 20,
      actualStart: null,
      actualEnd: null,
    };
    const steps = [
      { stepId: 'S1', status: 'handed_over' },
      { stepId: 'S2', status: 'handed_over' },
    ];
    const { db } = createGetDb([workOrder], steps, []);
    const updateReturning = jest.fn().mockResolvedValue([
      { ...workOrder, status: 'completed', progress: 100 },
    ]);
    const dbWithUpdate = {
      ...db,
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn(() => ({ returning: updateReturning })),
        })),
      })),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new MesService(dbWithUpdate as never, audit as never);

    const result = await service.transitionWorkOrder(
      'WO-1',
      'complete',
      undefined,
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );

    expect(result.status).toBe('completed');
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mes.work_order.complete' }),
    );
  });

  it('rejects completion while steps are unfinished', async () => {
    const workOrder = {
      scheduleTaskId: 'WO-1',
      title: '装配',
      status: 'in_progress',
      progress: 20,
      actualStart: null,
      actualEnd: null,
    };
    const steps = [{ stepId: 'S1', status: 'reported' }];
    const { db } = createGetDb([workOrder], steps, []);
    const service = new MesService(
      { ...db, update: jest.fn() } as never,
      { appendAuditLog: jest.fn() } as never,
    );

    await expect(
      service.transitionWorkOrder('WO-1', 'complete', undefined),
    ).rejects.toThrow('All steps must be handed over');
  });
});

describe('MesService materials and quality', () => {
  it('records material consumption and audits it', async () => {
    const workOrder = {
      scheduleTaskId: 'WO-1',
      title: '装配',
      status: 'in_progress',
    };
    const bindingRow = { bindingId: 'MAT-1', quantity: '2' };
    const { db } = createGetDb([workOrder], [], []);
    const returning = jest.fn().mockResolvedValue([bindingRow]);
    const insert = jest.fn((_table: unknown) => ({
      values: jest.fn(() => ({ returning })),
    }));
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new MesService(
      { ...db, insert } as never,
      audit as never,
    );

    const result = await service.consumeMaterial(
      'WO-1',
      { materialId: 'M-1', quantity: 2, reason: '投料' },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );

    expect(result.bindingId).toBe('MAT-1');
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mes.material.consume' }),
    );
  });

  it('records a quality inspection event and step result', async () => {
    const workOrder = {
      scheduleTaskId: 'WO-1',
      title: '装配',
      status: 'in_progress',
    };
    const step = {
      stepId: 'S1',
      status: 'reported',
      assignedDeviceId: 'EXO-1',
      resultJson: null,
    };
    const { db } = createGetDb([workOrder], [step], []);
    const updateWhere = jest.fn().mockResolvedValue([]);
    const dbWithUpdate = {
      ...db,
      update: jest.fn(() => ({
        set: jest.fn(() => ({ where: updateWhere })),
      })),
      insert: jest.fn((_table: unknown) => ({
        values: jest.fn(() => ({ returning: jest.fn().mockResolvedValue([]) })),
      })),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new MesService(dbWithUpdate as never, audit as never);

    const result = await service.qualityInspection(
      'WO-1',
      {
        stepId: 'S1',
        result: 'fail',
        defectCode: 'SCRATCH',
        quantity: 1,
      },
      { userId: 'inspector-1', primaryOrgId: 'org-1' },
    );

    expect(result.eventId).toBeTruthy();
    expect(result.result).toBe('fail');
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mes.quality.inspect' }),
    );
    expect(dbWithUpdate.insert).toHaveBeenCalledWith(ewohEvent);
  });
});

describe('MesService step exception lifecycle', () => {
  function createStepTransitionDb(workOrder: unknown, step: unknown) {
    const { db } = createGetDb([workOrder], [step], []);
    const updateSet = jest.fn((values: Record<string, unknown>) => ({
      where: jest.fn(() => ({
        returning: jest.fn().mockResolvedValue([{ ...(step as object), ...values }]),
      })),
    }));
    const dbWithUpdate = {
      ...db,
      update: jest.fn(() => ({ set: updateSet })),
    };
    return { dbWithUpdate, updateSet };
  }

  it('stores exception details when a step is paused', async () => {
    const workOrder = {
      scheduleTaskId: 'WO-1',
      title: '装配',
      status: 'in_progress',
    };
    const step = {
      stepId: 'S1',
      status: 'in_progress',
      progress: 10,
      actualStart: null,
      actualEnd: null,
      resultJson: null,
    };
    const { dbWithUpdate, updateSet } = createStepTransitionDb(workOrder, step);
    const service = new MesService(
      dbWithUpdate as never,
      { appendAuditLog: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await service.transitionStep(
      'WO-1',
      'S1',
      'pause',
      { code: 'MATERIAL_MISSING', note: '缺料' },
      { userId: 'worker-1', primaryOrgId: 'org-1' },
    );

    const resultJson = updateSet.mock.calls[0][0]
      .resultJson as Record<string, unknown>;
    expect(resultJson.exception).toEqual(
      expect.objectContaining({
        code: 'MATERIAL_MISSING',
        note: '缺料',
        operator: 'worker-1',
      }),
    );
  });

  it('records a resume note when a paused step is resumed', async () => {
    const workOrder = {
      scheduleTaskId: 'WO-1',
      title: '装配',
      status: 'in_progress',
    };
    const step = {
      stepId: 'S1',
      status: 'paused',
      progress: 10,
      actualStart: null,
      actualEnd: null,
      resultJson: { exception: { note: '缺料' } },
    };
    const { dbWithUpdate, updateSet } = createStepTransitionDb(workOrder, step);
    const service = new MesService(
      dbWithUpdate as never,
      { appendAuditLog: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await service.transitionStep(
      'WO-1',
      'S1',
      'resume',
      { note: '补料完成' },
      { userId: 'worker-1', primaryOrgId: 'org-1' },
    );

    const resultJson = updateSet.mock.calls[0][0]
      .resultJson as Record<string, unknown>;
    expect(resultJson.resume).toEqual(
      expect.objectContaining({ note: '补料完成', operator: 'worker-1' }),
    );
    expect(resultJson.exception).toEqual({ note: '缺料' });
  });
});
