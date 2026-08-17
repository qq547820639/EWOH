/* v0.7 Batch10.4：实体着色纯函数测试 */
import type { SpatialEntity, CurrentWorldState } from '@shared/api.interface';
import {
  isExoDevice,
  getEntityColor,
  getDeviceColor,
  priorityLevelColor,
  resourceStatusColor,
} from './entityColors';

/**
 * CLI-733：以类型完整的 fixture 工厂替代原先的 `as const as never` 双重
 * 断言——缺省字段补合法值，覆盖字段显式传入，让测试重新享受编译期检查。
 */
function spatialEntity(overrides: Partial<SpatialEntity> = {}): SpatialEntity {
  return {
    id: `row-${overrides.entityId ?? 'E-0'}`,
    entityId: 'E-0',
    entityType: 'device',
    parentId: null,
    name: '设备',
    x: 0,
    y: 0,
    yaw: 0,
    bboxW: 1,
    bboxH: 1,
    status: 'idle',
    sourceType: 'real',
    confidence: 1,
    version: 1,
    extra: null,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    ...overrides,
  };
}

function worldState(overrides: Partial<CurrentWorldState> = {}): CurrentWorldState {
  return {
    ts: '2026-08-03T00:00:00.000Z',
    persons: [],
    devices: [],
    workstations: [],
    events: [],
    ...overrides,
  };
}

const exoEntity = spatialEntity({ entityId: 'EXO-001', name: '外骨骼装备' });
const normalEntity = spatialEntity({ entityId: 'D-001', name: '普通设备' });
const workstation = spatialEntity({
  entityId: 'WS-1',
  name: '工位1',
  entityType: 'workstation',
  status: 'producing',
});

describe('entityColors: isExoDevice', () => {
  it('EXO/外骨骼 匹配', () => {
    expect(isExoDevice(exoEntity)).toBe(true);
  });
  it('普通设备不匹配', () => {
    expect(isExoDevice(normalEntity)).toBe(false);
  });
});

describe('entityColors: getEntityColor', () => {
  it('production 模式工位占用率着色', () => {
    expect(getEntityColor(workstation, 'production', null)).toBe('#10b981');
    expect(
      getEntityColor(
        workstation,
        'production',
        worldState({
          workstations: [
            { entityId: 'WS-1', name: '工位1', x: 0, y: 0, status: 'producing', occupancy: 0.8 },
          ],
        }),
      ),
    ).toBe('#ef4444');
  });
  it('person 模式人员着色', () => {
    expect(
      getEntityColor(spatialEntity({ entityId: 'P-1', entityType: 'person' }), 'person', null),
    ).toBe('#06b6d4');
  });
  it('data_quality 按置信度', () => {
    expect(
      getEntityColor(spatialEntity({ entityId: 'E-1', confidence: 0.99 }), 'data_quality', null),
    ).toBe('#10b981');
    expect(
      getEntityColor(spatialEntity({ entityId: 'E-2', confidence: 0.7 }), 'data_quality', null),
    ).toBe('#ef4444');
  });
  it('未知模式回退默认蓝', () => {
    expect(getEntityColor(normalEntity, 'bogus', null)).toBe('#3b82f6');
  });
});

describe('entityColors: getDeviceColor', () => {
  it('exoskeleton 模式区分外骨骼', () => {
    expect(getDeviceColor(normalEntity, 'exoskeleton', null)).toBe('#4b5563');
  });
  it('device 模式在线绿/离线灰', () => {
    expect(
      getDeviceColor(
        normalEntity,
        'device',
        worldState({
          devices: [{ entityId: 'D-001', name: '普通设备', x: 0, y: 0, status: 'online' }],
        }),
      ),
    ).toBe('#10b981');
  });
});

describe('entityColors: priorityLevelColor / resourceStatusColor', () => {
  it('priority 等级映射', () => {
    expect(priorityLevelColor('urgent')).toBe('#ef4444');
    expect(priorityLevelColor('low')).toBe('#3b82f6');
    expect(priorityLevelColor(undefined)).toBe('#a855f7');
  });
  it('resource 状态映射', () => {
    expect(resourceStatusColor('offline')).toBe('#ef4444');
    expect(resourceStatusColor('executing')).toBe('#f97316');
  });
});
