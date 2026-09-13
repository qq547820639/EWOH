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
    // org 隔离（W4）：契约路由透传 userContext（org 谓词同 DashboardService）。
    const userContext = { userId: 'user-1', primaryOrgId: 'org-1' };

    await controller.list(
      'EXO',
      undefined,
      undefined,
      undefined,
      'simulated',
      'environment_sensor', // 设备类别过滤（感知层入台账）
      'A1',
      'battery',
      undefined,
      undefined,
      { userContext },
    );
    expect(service.getDevices).toHaveBeenCalledWith(
      {
        keyword: 'EXO',
        sourceType: 'simulated',
        category: 'environment_sensor',
        model: 'A1',
        orderby: 'battery',
      },
      userContext,
    );

    await expect(controller.detail('EXO-001')).resolves.toEqual({ deviceId: 'EXO-001' });
    expect(service.getDeviceDetail).toHaveBeenCalledWith('EXO-001', undefined);

    await controller.bind('EXO-001', {
      targetId: 'person-1',
      bindingType: 'person',
      startedAt: '2026-08-03T00:00:00.000Z',
    } as never);
    expect(service.bindDevice).toHaveBeenCalledWith(
      'EXO-001',
      {
        targetId: 'person-1',
        bindingType: 'person',
        startedAt: '2026-08-03T00:00:00.000Z',
      },
      undefined,
    );
  });

  /* 人工能力生命周期是**能力台账的唯一人工写入口**（此前只有自动声明），
   * 必须走契约路由且透传 org 上下文（跨租户 404 由 Service 保证）。 */
  it('delegates capability status change to DashboardService（含 org 透传）', async () => {
    const service = {
      setDeviceCapabilityStatus: jest.fn().mockResolvedValue({
        deviceId: 'ENV-1',
        capabilityId: 'cap:device:ENV-1:observe.temperature',
        capabilityName: 'observe.temperature',
        status: 'disabled',
        previousStatus: 'active',
        changed: true,
      }),
    };
    const controller = new DeviceContractController(service as never);
    const userContext = { userId: 'user-1', primaryOrgId: 'org-1' };
    const body = { status: 'disabled' as const, reason: '该设备实际无温度传感器' };

    await controller.setCapabilityStatus('ENV-1', 'observe.temperature', body, { userContext });

    expect(service.setDeviceCapabilityStatus).toHaveBeenCalledWith(
      'ENV-1',
      'observe.temperature',
      body,
      userContext,
    );
  });
});
