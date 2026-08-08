/* v0.7 Batch10.4：实体着色纯函数测试 */
import {
  isExoDevice,
  getEntityColor,
  getDeviceColor,
  priorityLevelColor,
  resourceStatusColor,
} from './entityColors';

const exoEntity = { entityId: 'EXO-001', name: '外骨骼装备', entityType: 'device' } as const;
const normalEntity = { entityId: 'D-001', name: '普通设备', entityType: 'device' } as const;
const workstation = { entityId: 'WS-1', name: '工位1', entityType: 'workstation', status: 'producing' } as const;

describe('entityColors: isExoDevice', () => {
  it('EXO/外骨骼 匹配', () => {
    expect(isExoDevice(exoEntity as never)).toBe(true);
  });
  it('普通设备不匹配', () => {
    expect(isExoDevice(normalEntity as never)).toBe(false);
  });
});

describe('entityColors: getEntityColor', () => {
  it('production 模式工位占用率着色', () => {
    expect(getEntityColor(workstation as never, 'production', null)).toBe('#10b981');
    expect(
      getEntityColor(workstation as never, 'production', {
        workstations: [{ entityId: 'WS-1', occupancy: 0.8 }],
      } as never),
    ).toBe('#ef4444');
  });
  it('person 模式人员着色', () => {
    expect(getEntityColor({ entityId: 'P-1', entityType: 'person' } as never, 'person', null)).toBe('#06b6d4');
  });
  it('data_quality 按置信度', () => {
    expect(getEntityColor({ entityId: 'E-1', confidence: 0.99 } as never, 'data_quality', null)).toBe('#10b981');
    expect(getEntityColor({ entityId: 'E-2', confidence: 0.7 } as never, 'data_quality', null)).toBe('#ef4444');
  });
  it('未知模式回退默认蓝', () => {
    expect(getEntityColor(normalEntity as never, 'bogus', null)).toBe('#3b82f6');
  });
});

describe('entityColors: getDeviceColor', () => {
  it('exoskeleton 模式区分外骨骼', () => {
    expect(getDeviceColor(normalEntity as never, 'exoskeleton', null)).toBe('#4b5563');
  });
  it('device 模式在线绿/离线灰', () => {
    expect(
      getDeviceColor(normalEntity as never, 'device', { devices: [{ entityId: 'D-001', status: 'online' }] } as never),
    ).toBe('#10b981');
  });
});

describe('entityColors: priorityLevelColor / resourceStatusColor', () => {
  it('priority 等级映射', () => {
    expect(priorityLevelColor('urgent')).toBe('#ef4444');
    expect(priorityLevelColor('low')).toBe('#3b82f6');
    expect(priorityLevelColor(undefined)).toBe('#a855f7');
  });
  it('资源状态映射', () => {
    expect(resourceStatusColor('offline')).toBe('#ef4444');
    expect(resourceStatusColor('busy')).toBe('#f97316');
    expect(resourceStatusColor('available')).toBe('#34d399');
    expect(resourceStatusColor(undefined)).toBe('#34d399');
  });
});
