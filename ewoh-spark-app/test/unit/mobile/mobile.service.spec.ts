import { ForbiddenException } from '@nestjs/common';
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

    // NEST-412：personId 必须是本人（或特权角色）——查询与身份同源。
    const rows = await service.listWorkbench('person-1', {
      userId: 'auth-user-1',
      personId: 'person-1',
      primaryOrgId: 'org-1',
      roles: ['worker'],
    } as never);

    expect(rows).toHaveLength(1);
    expect(rows[0].stepId).toBe('S1');
    expect(where).toHaveBeenCalledTimes(1);
    const predicate = sqlText(
      (where as unknown as jest.Mock).mock.calls[0]?.[0] ?? '',
    );
    expect(predicate).toContain('assigned_person_id');
    expect(predicate).toContain('person-1');
    expect(predicate).toContain('org-1');
  });

  it('NEST-412: querying another person\'s workbench without a privileged role → Forbidden', async () => {
    const db = { select: jest.fn() };
    const service = new MobileService(db as never, {} as never);

    await expect(
      service.listWorkbench('person-other', {
        userId: 'auth-user-1',
        personId: 'person-1',
        primaryOrgId: 'org-1',
        roles: ['worker'],
      } as never),
    ).rejects.toThrow(/personId mismatch/);
    // 特权角色（workshop_lead）可代查。
    const orderBy = jest.fn().mockResolvedValue([]);
    const where = jest.fn(() => ({ orderBy }));
    const privilegedDb = {
      select: jest.fn(() => ({ from: jest.fn(() => ({ where })) })),
    };
    const privilegedService = new MobileService(privilegedDb as never, {} as never);
    await expect(
      privilegedService.listWorkbench('person-other', {
        userId: 'user-1',
        personId: 'person-1',
        primaryOrgId: 'org-1',
        roles: ['workshop_lead'],
      } as never),
    ).resolves.toEqual([]);
    expect(where).toHaveBeenCalledTimes(1);
  });

  it('uses the signed person binding, not the auth user id, for worker self-scope', async () => {
    const orderBy = jest.fn().mockResolvedValue([]);
    const where = jest.fn(() => ({ orderBy }));
    const db = {
      select: jest.fn(() => ({ from: jest.fn(() => ({ where })) })),
    };
    const service = new MobileService(db as never, {} as never);
    const actor = {
      userId: 'auth-user-1',
      personId: 'person-1',
      primaryOrgId: 'org-1',
      roles: ['worker'],
    };

    await expect(
      service.listWorkbench('person-1', actor as never),
    ).resolves.toEqual([]);
    expect(where).toHaveBeenCalledTimes(1);
  });

  it('rejects a worker whose signed person binding differs from the requested workbench', async () => {
    const db = { select: jest.fn() };
    const service = new MobileService(db as never, {} as never);

    await expect(
      service.listWorkbench('person-other', {
        userId: 'auth-user-1',
        personId: 'person-1',
        primaryOrgId: 'org-1',
        roles: ['worker'],
      } as never),
    ).rejects.toThrow(ForbiddenException);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('fails closed when a worker has no trusted person binding or tenant context', async () => {
    const db = { select: jest.fn() };
    const service = new MobileService(db as never, {} as never);

    await expect(
      service.listWorkbench('person-1', {
        userId: 'auth-user-1',
        primaryOrgId: 'org-1',
        roles: ['worker'],
      } as never),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.listWorkbench('person-1', undefined),
    ).rejects.toThrow(ForbiddenException);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('scopes assigned-device execution facts to the caller org without a NULL-org bypass', async () => {
    const orderBy = jest.fn().mockResolvedValue([
      { deviceId: 'device-1' },
      { deviceId: 'device-2' },
    ]);
    const where = jest.fn((predicate: unknown) => ({ orderBy }));
    const db = {
      select: jest.fn(() => ({ from: jest.fn(() => ({ where })) })),
    };
    const control = {
      listDeviceCommands: jest.fn()
      .mockResolvedValueOnce({
        summary: {
          inFlight: 1,
          queued: 2,
          awaitingDelivery: 3,
          overdue: 4,
          oldestWaitingMs: 5,
          busyBlocker: null,
          queuedReasons: null,
        },
      })
      .mockResolvedValueOnce({
        summary: {
          inFlight: 0,
          queued: 0,
          awaitingDelivery: 0,
          overdue: 0,
          oldestWaitingMs: null,
          busyBlocker: null,
          queuedReasons: null,
        },
      }),
    };
    const mes = {
      getWorkOrder: jest.fn().mockResolvedValue({
        workOrder: { scheduleTaskId: 'task-1' },
      }),
    };
    const service = new MobileService(db as never, mes as never, control as never);
    const actor = {
      userId: 'auth-user-1',
      personId: 'person-1',
      primaryOrgId: 'org-1',
      roles: ['worker'],
    };

    const result = await service.getOrder('WO-1', actor as never);
    expect(result.deviceExecution).toMatchObject({
      deviceId: 'device-1',
      otherStuckCount: 0,
    });
    expect(control.listDeviceCommands).toHaveBeenCalledWith(
      'device-1',
      { limit: 10 },
      actor,
    );
    const predicate = sqlText(where.mock.calls[0]?.[0] ?? '');
    expect(predicate).toContain('task-1');
    expect(predicate).toContain('org-1');
    expect(predicate).not.toContain('is null');
  });

  it('does not query device assignments without trusted tenant context', async () => {
    const db = { select: jest.fn() };
    const mes = {
      getWorkOrder: jest.fn().mockResolvedValue({
        workOrder: { scheduleTaskId: 'task-1' },
      }),
    };
    const service = new MobileService(db as never, mes as never);

    const result = await service.getOrder('WO-1', undefined);
    expect(result.deviceExecution).toBeNull();
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

    // R2-SAM-002：扫码 facade 显式透传租户上下文（actor 缺省 fail-closed）。
    await expect(
      service.scan('WO:WO-1', { userId: 'user-1', primaryOrgId: 'org-1' }),
    ).resolves.toMatchObject({
      workOrder: { scheduleTaskId: 'WO-1' },
    });
    expect(mes.getWorkOrder).toHaveBeenCalledWith('WO-1', {
      userId: 'user-1',
      primaryOrgId: 'org-1',
    });
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
