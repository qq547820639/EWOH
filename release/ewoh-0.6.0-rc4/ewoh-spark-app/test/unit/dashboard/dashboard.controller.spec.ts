import { DashboardController } from '../../../server/modules/dashboard/dashboard.controller';

describe('DashboardController', () => {
  it('passes userContext into updateDevice and handleEvent', async () => {
    const service = {
      updateDevice: jest.fn().mockResolvedValue({ deviceId: 'EXO-001' }),
      handleEvent: jest.fn().mockResolvedValue({ eventId: 'EVT-001' }),
    };
    const controller = new DashboardController(service as never);
    const userContext = { userId: 'user-1', primaryOrgId: 'org-1' } as never;

    await controller.updateDevice('EXO-001', { online: true } as never, {
      userContext,
    } as never);
    expect(service.updateDevice).toHaveBeenCalledWith('EXO-001', { online: true }, userContext);

    await controller.handleEvent(
      'EVT-001',
      { handlerAction: 'acknowledge', handlerNote: 'ok' },
      { userContext } as never,
    );
    expect(service.handleEvent).toHaveBeenCalledWith(
      'EVT-001',
      'acknowledge',
      'ok',
      undefined,
      userContext,
    );
  });
});
