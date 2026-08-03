import { MobileService } from '../../../server/modules/mobile/mobile.service';

describe('MobileService', () => {
  it('lists assigned workbench steps', async () => {
    const orderBy = jest.fn().mockResolvedValue([
      { stepId: 'S1', status: 'in_progress' },
    ]);
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({ orderBy })),
        })),
      })),
    };
    const mes = { getWorkOrder: jest.fn(), transitionStep: jest.fn() };
    const service = new MobileService(db as never, mes as never);

    const rows = await service.listWorkbench('P-1');

    expect(rows).toHaveLength(1);
    expect(rows[0].stepId).toBe('S1');
  });

  it('delegates scan and step transitions to MesService', async () => {
    const mes = {
      getWorkOrder: jest.fn().mockResolvedValue({ workOrder: { scheduleTaskId: 'WO-1' } }),
      transitionStep: jest.fn().mockResolvedValue({ stepId: 'S1', status: 'reported' }),
    };
    const service = new MobileService({} as never, mes as never);

    const scanned = await service.scanOrder('WO-1');
    expect(scanned.workOrder.scheduleTaskId).toBe('WO-1');

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
