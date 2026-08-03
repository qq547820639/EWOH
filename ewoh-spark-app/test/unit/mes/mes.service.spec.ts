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

describe('MesService SOP registry and confirmation gating', () => {
  function createStepTransitionDb(workOrder: unknown, step: unknown) {
    const { db } = createGetDb([workOrder], [step], []);
    const updateSet = jest.fn((values: Record<string, unknown>) => ({
      where: jest.fn(() => ({
        returning: jest.fn().mockResolvedValue([{ ...(step as object), ...values }]),
      })),
    }));
    return {
      dbWithUpdate: {
        ...db,
        update: jest.fn(() => ({ set: updateSet })),
      },
      updateSet,
    };
  }

  it('registers a versioned SOP asset with audit', async () => {
    const row = {
      packageId: 'SOP-1',
      packageType: 'sop',
      name: '上料 SOP',
      version: '1.0.0',
      status: 'draft',
    };
    const insert = jest.fn((_table: unknown) => ({
      values: jest.fn(() => ({ returning: jest.fn().mockResolvedValue([row]) })),
    }));
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new MesService({ insert } as never, audit as never);

    const result = await service.registerSop({
      title: '上料 SOP',
      version: '1.0.0',
      steps: [{ name: '准备工具', mandatory: true, tools: ['扳手'] }],
    });

    expect(result.packageId).toBe('SOP-1');
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mes.sop.register' }),
    );
  });

  it('requires SOP sign-off and tool/material confirmations before start', async () => {
    const workOrder = {
      scheduleTaskId: 'WO-1',
      title: '装配',
      status: 'in_progress',
    };
    const step = {
      stepId: 'S1',
      status: 'pending',
      progress: 0,
      actualStart: null,
      actualEnd: null,
      resultJson: {
        sop: {
          sopId: 'SOP-1',
          version: '1.0.0',
          mandatory: true,
          requiredTools: ['扳手'],
          requiredMaterials: ['螺栓'],
        },
      },
    };
    const { dbWithUpdate, updateSet } = createStepTransitionDb(workOrder, step);
    const service = new MesService(
      dbWithUpdate as never,
      { appendAuditLog: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await expect(
      service.transitionStep('WO-1', 'S1', 'start', {}),
    ).rejects.toThrow('SOP_SIGN_REQUIRED');

    await expect(
      service.transitionStep('WO-1', 'S1', 'start', { sopSigned: true }),
    ).rejects.toThrow('SOP_TOOLS_REQUIRED');

    const result = await service.transitionStep(
      'WO-1',
      'S1',
      'start',
      {
        sopSigned: true,
        confirmedTools: ['扳手'],
        confirmedMaterials: ['螺栓'],
      },
      { userId: 'worker-1', primaryOrgId: 'org-1' },
    );

    expect(result.status).toBe('in_progress');
    const resultJson = updateSet.mock.calls[0][0]
      .resultJson as Record<string, unknown>;
    expect(
      (resultJson.sop as Record<string, unknown>).signatures,
    ).toEqual(
      expect.objectContaining({
        signedBy: 'worker-1',
        tools: ['扳手'],
        materials: ['螺栓'],
      }),
    );
  });

  it('computes SOP version differences by step name and content', async () => {
    const from = {
      packageId: 'SOP-1',
      packageType: 'sop',
      manifestJson: {
        steps: [
          { name: '准备', instruction: 'old' },
          { name: '移除', instruction: 'x' },
        ],
      },
    };
    const to = {
      packageId: 'SOP-2',
      packageType: 'sop',
      manifestJson: {
        steps: [
          { name: '准备', instruction: 'new' },
          { name: '新增', instruction: 'y' },
        ],
      },
    };
    const where = jest
      .fn()
      .mockResolvedValueOnce([from])
      .mockResolvedValueOnce([to]);
    const select = jest.fn(() => ({
      from: jest.fn(() => ({
        where,
      })),
    }));
    const service = new MesService(
      { select } as never,
      { appendAuditLog: jest.fn() } as never,
    );

    const diff = await service.diffSops('SOP-1', 'SOP-2');

    expect(diff.added).toEqual(['新增']);
    expect(diff.removed).toEqual(['移除']);
    expect(diff.changed).toEqual(['准备']);
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
        steps: [
          {
            name: '上料',
            sopId: 'SOP-1',
            sopVersion: '1.0.0',
            sopMandatory: true,
            requiredTools: ['扳手'],
            requiredMaterials: ['螺栓'],
          },
          { name: '装配' },
        ],
      },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );

    expect(result.workOrder.scheduleTaskId).toBe('WO-1');
    expect(insert).toHaveBeenCalledTimes(2);
    expect(insertEntries[0].table).toBe(ewohScheduleTask);
    expect(insertEntries[1].table).toBe(ewohScheduleTaskStep);
    const firstStep = (
      insertEntries[1].rows as Array<{
        resultJson: { sop: Record<string, unknown> } | null;
      }>
    )[0];
    expect(firstStep.resultJson?.sop).toEqual(
      expect.objectContaining({
        sopId: 'SOP-1',
        version: '1.0.0',
        mandatory: true,
        requiredTools: ['扳手'],
        requiredMaterials: ['螺栓'],
      }),
    );
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
      {
        code: 'MATERIAL_MISSING',
        note: '缺料',
        attachments: [
          {
            id: 'file-1',
            filename: '缺料.jpg',
            contentType: 'image/jpeg',
            url: 'https://example.test/files/file-1',
            extra: 'dropped',
          },
        ],
      },
      { userId: 'worker-1', primaryOrgId: 'org-1' },
    );

    const resultJson = updateSet.mock.calls[0][0]
      .resultJson as Record<string, unknown>;
    expect(resultJson.exception).toEqual(
      expect.objectContaining({
        code: 'MATERIAL_MISSING',
        note: '缺料',
        operator: 'worker-1',
        attachments: [
          {
            id: 'file-1',
            filename: '缺料.jpg',
            contentType: 'image/jpeg',
            url: 'https://example.test/files/file-1',
          },
        ],
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

  it('rejects a worker operating a step assigned to another person', async () => {
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
      assignedPersonId: 'other-worker',
      resultJson: null,
    };
    const { dbWithUpdate } = createStepTransitionDb(workOrder, step);
    const service = new MesService(
      dbWithUpdate as never,
      { appendAuditLog: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await expect(
      service.transitionStep(
        'WO-1',
        'S1',
        'report',
        { quantity: 1 },
        { userId: 'worker-1', primaryOrgId: 'org-1', role: 'worker' },
      ),
    ).rejects.toThrow('WORKER_STEP_ASSIGNMENT_REQUIRED');
  });

  it('allows a worker to operate their own step', async () => {
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
      assignedPersonId: 'worker-1',
      resultJson: null,
    };
    const { dbWithUpdate } = createStepTransitionDb(workOrder, step);
    const service = new MesService(
      dbWithUpdate as never,
      { appendAuditLog: jest.fn().mockResolvedValue(undefined) } as never,
    );

    const result = await service.transitionStep(
      'WO-1',
      'S1',
      'report',
      { quantity: 1 },
      { userId: 'worker-1', primaryOrgId: 'org-1', role: 'worker' },
    );

    expect(result.status).toBe('reported');
  });
});
