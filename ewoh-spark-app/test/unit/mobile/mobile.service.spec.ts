import {
  MobileService,
  parseScanValue,
} from '../../../server/modules/mobile/mobile.service';

function sqlText(
  value: unknown,
  seen = new WeakSet<object>(),
): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sqlText(item, seen)).join(' ');
  }
  if (!value || typeof value !== 'object') {
    return String(value ?? '');
  }
  if (seen.has(value)) {
    return '';
  }
  seen.add(value);
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof record.value === 'string') parts.push(record.value);
  if (typeof record.name === 'string') parts.push(record.name);
  if (Array.isArray(record.queryChunks)) {
    parts.push(sqlText(record.queryChunks, seen));
  }
  return parts.join(' ');
}

describe('MobileService', () => {
  it('lists only steps assigned to the caller within the caller org', async () => {
    const orderBy = jest.fn().mockResolvedValue([
      { stepId: 'S1', status: 'in_progress' },
    ]);
    const where = jest.fn(() => ({ orderBy }));
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where })),
      })),
    };
    const mes = { getWorkOrder: jest.fn(), transitionStep: jest.fn() };
    const service = new MobileService(db as never, mes as never);

    const rows = await service.listWorkbench('P-1', {
      userId: 'user-1',
      primaryOrgId: 'org-1',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].stepId).toBe('S1');
    expect(where).toHaveBeenCalledTimes(1);
    const predicate = sqlText(
      (where as unknown as jest.Mock).mock.calls[0]?.[0] ?? '',
    );
    expect(predicate).toContain('assigned_person_id');
    expect(predicate).toContain('P-1');
    expect(predicate).toContain('org-1');
  });

  it('fails closed when the caller has no person or org context', async () => {
    const db = { select: jest.fn() };
    const service = new MobileService(db as never, {} as never);

    await expect(
      service.listWorkbench('', {
        userId: 'user-1',
        primaryOrgId: 'org-1',
      }),
    ).resolves.toEqual([]);
    await expect(
      service.listWorkbench('P-1', undefined),
    ).resolves.toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('parses typed scan values for factory/station/device/order/step/material/batch', () => {
    expect(parseScanValue('WO:WO-1')).toEqual({
      scanType: 'work_order',
      reference: 'WO-1',
    });
    expect(parseScanValue('order:O-1')).toEqual({
      scanType: 'order',
      reference: 'O-1',
    });
    expect(parseScanValue('STEP:S1')).toEqual({
      scanType: 'step',
      reference: 'S1',
    });
    expect(parseScanValue('DEVICE:D-1')).toEqual({
      scanType: 'device',
      reference: 'D-1',
    });
    expect(parseScanValue('MAT:M-1')).toEqual({
      scanType: 'material',
      reference: 'M-1',
    });
    expect(parseScanValue('BATCH:B-1')).toEqual({
      scanType: 'batch',
      reference: 'B-1',
    });
    expect(parseScanValue('STATION:WS-1')).toEqual({
      scanType: 'station',
      reference: 'WS-1',
    });
    expect(parseScanValue('FACTORY:F-1')).toEqual({
      scanType: 'factory',
      reference: 'F-1',
    });
    expect(parseScanValue('WO:')).toBeNull();
  });

  it('resolves work order scans through MesService', async () => {
    const mes = {
      getWorkOrder: jest
        .fn()
        .mockResolvedValue({ workOrder: { scheduleTaskId: 'WO-1' } }),
      getStep: jest.fn(),
    };
    const service = new MobileService({} as never, mes as never);

    await expect(service.scan('WO:WO-1')).resolves.toMatchObject({
      workOrder: { scheduleTaskId: 'WO-1' },
    });
    expect(mes.getWorkOrder).toHaveBeenCalledWith('WO-1');
  });

  it('resolves step scans to the step and its work order', async () => {
    const mes = {
      getStep: jest
        .fn()
        .mockResolvedValue({ stepId: 'S1', scheduleTaskId: 'WO-1' }),
      getWorkOrder: jest
        .fn()
        .mockResolvedValue({ workOrder: { scheduleTaskId: 'WO-1' } }),
    };
    const service = new MobileService({} as never, mes as never);

    const result = await service.scan('STEP:S1');

    expect(result).toMatchObject({
      scanType: 'step',
      step: { stepId: 'S1', scheduleTaskId: 'WO-1' },
      workOrder: { scheduleTaskId: 'WO-1' },
    });
  });

  it('returns recognized references for device/material/batch/station/factory', async () => {
    const service = new MobileService({} as never, {} as never);

    await expect(service.scan('DEV:D-1')).resolves.toMatchObject({
      scanType: 'device',
      reference: 'D-1',
      recognized: true,
    });
    await expect(service.scan('MAT:M-1')).resolves.toMatchObject({
      scanType: 'material',
      reference: 'M-1',
      recognized: true,
    });
  });

  it('delegates step transitions to MesService', async () => {
    const mes = {
      getWorkOrder: jest.fn(),
      transitionStep: jest.fn().mockResolvedValue({ stepId: 'S1', status: 'reported' }),
    };
    const service = new MobileService({} as never, mes as never);

    const transitioned = await service.transitionStep(
      'WO-1',
      'S1',
      'report',
      { quantity: 1 },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );
    expect(transitioned.status).toBe('reported');
    expect(mes.transitionStep).toHaveBeenCalledWith(
      'WO-1',
      'S1',
      'report',
      { quantity: 1 },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );
  });

  it('delegates mobile quality inspection to MesService', async () => {
    const mes = {
      qualityInspection: jest
        .fn()
        .mockResolvedValue({ stepId: 'S1', eventId: 'QI-1', result: 'pass' }),
    };
    const service = new MobileService({} as never, mes as never);

    const result = await service.inspectStep(
      'WO-1',
      { stepId: 'S1', result: 'pass', note: 'ok' },
      { userId: 'worker-1', primaryOrgId: 'org-1' },
    );

    expect(result.eventId).toBe('QI-1');
    expect(mes.qualityInspection).toHaveBeenCalledWith(
      'WO-1',
      { stepId: 'S1', result: 'pass', note: 'ok' },
      { userId: 'worker-1', primaryOrgId: 'org-1' },
    );
  });
});
