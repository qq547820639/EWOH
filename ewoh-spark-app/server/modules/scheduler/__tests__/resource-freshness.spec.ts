/* 差异化新鲜度策略（Task 3 / 3.4）单元测试。
 *
 * 覆盖：不同 resourceType+signalType 使用不同阈值；STALE/UNKNOWN 不被视为
 * 可用（fail-closed，safety-critical 依赖该不变量）；tool/material/vehicle
 * 适配器为显式 NOT_AVAILABLE 占位（空投影、不虚构行）。
 * 不依赖真实 DB —— 通过 mock reservation 数据源与 drizzle select 内存行。
 */
/// <reference types="jest" />
import { ResourceProjectionService, DEFAULT_FRESHNESS_POLICY } from '../resource-projection.service';
import {
  PersonnelAdapter,
  DeviceAdapter,
  StationAdapter,
  ToolAdapter,
  MaterialAdapter,
  VehicleAdapter,
  RESOURCE_NOT_AVAILABLE,
} from '../resource-adapters';
import {
  ewohPersonnel,
  ewohDevice,
  ewohSpatialEntity,
} from '@server/database/schema';
import type { ReservationResult } from '../resource-reservation.service';

const MINUTE = 60 * 1000;

function personRow(over: Record<string, unknown> = {}) {
  return {
    id: 'P1',
    name: 'P1',
    employeeNo: 'E1',
    status: 'available',
    skills: ['work'],
    certifications: [],
    currentLoad: null,
    spatialEntityId: null,
    teamName: null,
    healthStatus: 'normal',
    version: 1,
    updatedAt: new Date(),
    ...over,
  };
}

function deviceRow(over: Record<string, unknown> = {}) {
  return {
    id: 'D1',
    deviceId: 'D1',
    workerName: null,
    deviceModel: 'exo-lift',
    batteryPct: 90,
    online: true,
    faultCode: null,
    lastTelemetryAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function stationRow(over: Record<string, unknown> = {}) {
  return {
    id: 'S1',
    entityId: 'ST-01',
    entityType: 'station',
    parentId: 'Z-1',
    name: 'Station 1',
    x: 0,
    y: 0,
    status: 'active',
    version: 1,
    updatedAt: new Date(),
    ...over,
  };
}

describe('差异化新鲜度策略（FreshnessPolicy）', () => {
  function makeSvc(
    personnelRows: unknown[],
    deviceRows: unknown[],
    spatialRows: unknown[],
    reservations: ReservationResult[] = [],
  ) {
    const reservationService = {
      listActive: jest.fn().mockResolvedValue(reservations),
    };
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn((t: unknown) => {
          if (t === ewohPersonnel) return Promise.resolve(personnelRows);
          if (t === ewohDevice) return Promise.resolve(deviceRows);
          if (t === ewohSpatialEntity) return Promise.resolve(spatialRows);
          return Promise.resolve([]);
        }),
      }),
    };
    return new ResourceProjectionService(db as never, reservationService as never);
  }

  it('不同资源类型使用不同阈值：same-age 的 device 为 STALE、person 为 FRESH', async () => {
    const now = Date.now();
    // 统一 2 分钟龄：device:telemetry 阈值 60s → STALE；person:master 阈值 5min → FRESH。
    const age = 2 * MINUTE;
    const svc = makeSvc(
      [personRow({ id: 'P-MID', updatedAt: new Date(now - age) })],
      [
        deviceRow({
          id: 'D-MID',
          deviceId: 'D-MID',
          lastTelemetryAt: new Date(now - age),
        }),
      ],
      [],
    );
    const states = await svc.getUnifiedResourceState();
    const person = states.find((s) => s.id === 'P-MID')!;
    const device = states.find((s) => s.id === 'D-MID')!;

    expect(DEFAULT_FRESHNESS_POLICY.thresholdsMs['device:telemetry']).toBeLessThan(
      DEFAULT_FRESHNESS_POLICY.thresholdsMs['person:master'],
    );
    expect(device.dataQuality).toBe('STALE');
    expect(person.dataQuality).toBe('FRESH');
    // 各自命中差异化阈值（freshnessMs 来自策略，而非统一默认值）。
    expect(device.freshnessMs).toBe(1 * MINUTE);
    expect(person.freshnessMs).toBe(5 * MINUTE);
    expect(device.freshnessPolicyVersion).toBe(1);
    expect(person.freshnessPolicyVersion).toBe(1);
  });

  it('STALE 不被视为可派工：person→unavailable、device→offline', async () => {
    const now = Date.now();
    const svc = makeSvc(
      [personRow({ id: 'P-STALE', updatedAt: new Date(now - 6 * MINUTE) })],
      [
        deviceRow({
          id: 'D-STALE',
          deviceId: 'D-STALE',
          lastTelemetryAt: new Date(now - 2 * MINUTE),
        }),
      ],
      [],
    );
    const states = await svc.getUnifiedResourceState();
    const person = states.find((s) => s.id === 'P-STALE')!;
    const device = states.find((s) => s.id === 'D-STALE')!;
    expect(person.dataQuality).toBe('STALE');
    expect(person.status).toBe('unavailable');
    expect(device.dataQuality).toBe('STALE');
    expect(device.status).toBe('offline');
  });

  it('UNKNOWN（null sourceTs）不被视为可派工：person→unavailable、device→offline', async () => {
    const svc = makeSvc(
      [personRow({ id: 'P-UNK', updatedAt: null })],
      [
        deviceRow({
          id: 'D-UNK',
          deviceId: 'D-UNK',
          lastTelemetryAt: null,
          updatedAt: null,
        }),
      ],
      [],
    );
    const states = await svc.getUnifiedResourceState();
    const person = states.find((s) => s.id === 'P-UNK')!;
    const device = states.find((s) => s.id === 'D-UNK')!;
    expect(person.dataQuality).toBe('UNKNOWN');
    expect(person.status).toBe('unavailable');
    expect(device.dataQuality).toBe('UNKNOWN');
    expect(device.status).toBe('offline');
  });

  it('safety-critical fail-closed 不变量：未知/过时资源投影为不可用', async () => {
    // 投影层保证 UNKNOWN/STALE 资源绝不带 available/online 状态；求解器据此
    // 对 safety-critical 任务 fail-closed（不把不可用/未知资源指派给安全关键任务）。
    const now = Date.now();
    const svc = makeSvc(
      [
        personRow({ id: 'P-UNK', updatedAt: null }),
        personRow({ id: 'P-FRESH', updatedAt: new Date(now) }),
      ],
      [
        deviceRow({
          id: 'D-UNK',
          deviceId: 'D-UNK',
          lastTelemetryAt: null,
          updatedAt: null,
        }),
      ],
      [],
    );
    const states = await svc.getUnifiedResourceState();
    const unknownPerson = states.find((s) => s.id === 'P-UNK')!;
    const unknownDevice = states.find((s) => s.id === 'D-UNK')!;
    const freshPerson = states.find((s) => s.id === 'P-FRESH')!;
    expect(freshPerson.dataQuality).toBe('FRESH');
    expect(freshPerson.status).toBe('available');
    // 未知资源 → 不可用（无 available/online 泄露）。
    expect(unknownPerson.dataQuality).toBe('UNKNOWN');
    expect(unknownPerson.status).not.toBe('available');
    expect(unknownDevice.dataQuality).toBe('UNKNOWN');
    expect(unknownDevice.status).not.toBe('online');
  });
});

describe('资源投影适配器（ResourceProjectionAdapter）', () => {
  function makeSvc(
    personnelRows: unknown[],
    deviceRows: unknown[],
    spatialRows: unknown[],
  ) {
    const reservationService = {
      listActive: jest.fn().mockResolvedValue([]),
    };
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn((t: unknown) => {
          if (t === ewohPersonnel) return Promise.resolve(personnelRows);
          if (t === ewohDevice) return Promise.resolve(deviceRows);
          if (t === ewohSpatialEntity) return Promise.resolve(spatialRows);
          return Promise.resolve([]);
        }),
      }),
    };
    return new ResourceProjectionService(db as never, reservationService as never);
  }

  it('person/device/station 适配器委托投影服务并按类型过滤（复用数据源，不重复查询）', async () => {
    const svc = makeSvc([personRow({ id: 'P1' })], [deviceRow({ id: 'D1' })], [stationRow({ id: 'S1' })]);
    const personAdapter = new PersonnelAdapter(svc);
    const deviceAdapter = new DeviceAdapter(svc);
    const stationAdapter = new StationAdapter(svc);

    expect(personAdapter.adapterType()).toBe('person');
    expect(deviceAdapter.adapterType()).toBe('device');
    expect(stationAdapter.adapterType()).toBe('station');

    const persons = await personAdapter.getResources();
    const devices = await deviceAdapter.getResources();
    const stations = await stationAdapter.getResources();
    expect(persons).toHaveLength(1);
    expect(persons[0].type).toBe('person');
    expect(devices).toHaveLength(1);
    expect(devices[0].type).toBe('device');
    expect(stations).toHaveLength(1);
    expect(stations[0].type).toBe('station');
  });

  it('tool/material/vehicle 适配器为 NOT_AVAILABLE 占位：返回空投影且不虚构资源行', async () => {
    expect(RESOURCE_NOT_AVAILABLE).toBe('NOT_AVAILABLE');
    const adapters = [new ToolAdapter(), new MaterialAdapter(), new VehicleAdapter()];
    expect(adapters.map((a) => a.adapterType())).toEqual([
      'tool',
      'material',
      'vehicle',
    ]);
    for (const adapter of adapters) {
      const resources = await adapter.getResources();
      expect(resources).toEqual([]);
      // 显式占位语义：绝不伪造可用资源行。
      expect(resources.length).toBe(0);
    }
  });
});