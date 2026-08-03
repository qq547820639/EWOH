import { DeviceContractController } from '../../../server/modules/dashboard/device-contract.controller';
import { ROLES_KEY } from '../../../server/modules/shared/roles.decorator';

describe('DeviceContractController', () => {
  it('declares device roles for the target contract routes', () => {
    expect(Reflect.getMetadata(ROLES_KEY, DeviceContractController)).toEqual([
      'global_admin',
      'dispatcher',
      'device_ops',
    ]);
  });

  it('delegates list, detail, and bind to DashboardService', async () => {
    const service = {
      getDevices: jest.fn().mockResolvedValue([]),
      getDeviceDetail: jest.fn().mockResolvedValue({ deviceId: 'EXO-001' }),
      bindDevice: jest.fn().mockResolvedValue({ deviceId: 'EXO-001' }),
    };
    const controller = new DeviceContractController(service as never);

    await controller.list('EXO', undefined, undefined, undefined, 'simulated', 'A1', 'battery');
    expect(service.getDevices).toHaveBeenCalledWith({
      keyword: 'EXO',
      sourceType: 'simulated',
      model: 'A1',
      orderby: 'battery',
    });

    await expect(controller.detail('EXO-001')).resolves.toEqual({ deviceId: 'EXO-001' });
    expect(service.getDeviceDetail).toHaveBeenCalledWith('EXO-001');

    await controller.bind('EXO-001', {
      targetId: 'person-1',
      bindingType: 'person',
      startedAt: '2026-08-03T00:00:00.000Z',
    } as never);
    expect(service.bindDevice).toHaveBeenCalledWith('EXO-001', {
      targetId: 'person-1',
      bindingType: 'person',
      startedAt: '2026-08-03T00:00:00.000Z',
    });
  });
});
