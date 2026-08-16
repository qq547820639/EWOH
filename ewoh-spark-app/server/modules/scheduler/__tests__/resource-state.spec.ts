/* 统一资源状态聚合（ResourceStateAggregator）单元测试。
 *
 * 覆盖：reservations 水合、availableWindows 推导、freshness 判定。
 * 不依赖真实 DB —— 通过 mock reservation 数据源(listActive) 与
 * drizzle select().from() 返回的内存行。
 */
/// <reference types="jest" />
import { ResourceProjectionService } from '../resource-projection.service';
import {
  ewohPersonnel,
  ewohDevice,
  ewohSpatialEntity,
} from '@server/database/schema';
import type { ReservationResult } from '../resource-reservation.service';

const HOUR = 3600_000;

function personRow(over: Record<string, unknown> = {}) {
  return {
    id: 'P1',
    name: 'P1',
    employeeNo: 'E1',
    status: 'AVAILABLE',
    skills: ['work'],
    certifications: [],
    currentLoad: null,
    spatialEntityId: null,
    teamName: 'TEAM-A',
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

describe('ResourceProjectionService（统一资源状态聚合器）', () => {
  function makeSvc(
    personnelRows: unknown[],
    deviceRows: unknown[],
    spatialRows: unknown[],
    reservations: ReservationResult[],
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

  it('reservations 被水合到各资源的 reservations 字段', async () => {
    const now = Date.now();
    const reservations: ReservationResult[] = [
      {
        reservationId: 'RSV-P1',
        resourceType: 'person',
        resourceId: 'P1',
        startMs: now + HOUR,
        endMs: now + 2 * HOUR,
      },
      {
        reservationId: 'RSV-D1',
        resourceType: 'device',
        resourceId: 'D1',
        startMs: now + HOUR,
        endMs: now + 2 * HOUR,
      },
      {
        reservationId: 'RSV-ST01',
        resourceType: 'station',
        resourceId: 'ST-01',
        startMs: now + HOUR,
        endMs: now + 2 * HOUR,
      },
    ];
    const svc = makeSvc(
      [personRow()],
      [deviceRow()],
      [stationRow()],
      reservations,
    );

    const states = await svc.getUnifiedResourceState();
    const person = states.find((s) => s.id === 'P1');
    const device = states.find((s) => s.id === 'D1');
    const station = states.find((s) => s.type === 'station');

    expect(person?.reservations.map((r) => r.reservationId)).toEqual(['RSV-P1']);
    expect(device?.reservations.map((r) => r.reservationId)).toEqual(['RSV-D1']);
    expect(station?.reservations.map((r) => r.reservationId)).toEqual([
      'RSV-ST01',
    ]);
    // 无 preload 的资源水合为空数组（向后兼容）。
    expect(
      states.find((s) => s.id === 'P1')?.reservations[0].startMs,
    ).toBe(now + HOUR);
  });

  it('availableWindows 由真实 reservation 推导（占用区间被挖空）', async () => {
    const now = Date.now();
    const reservations: ReservationResult[] = [
      {
        reservationId: 'RSV-P1',
        resourceType: 'person',
        resourceId: 'P1',
        startMs: now + HOUR,
        endMs: now + 2 * HOUR,
      },
    ];
    const svc = makeSvc([personRow()], [], [], reservations);

    const states = await svc.getUnifiedResourceState();
    const person = states.find((s) => s.id === 'P1')!;
    expect(person.availableWindows.length).toBeGreaterThanOrEqual(2);
    // 所有可用窗口不得与占用区间 [now+HOUR, now+2*HOUR] 重叠。
    for (const w of person.availableWindows) {
      const overlaps =
        w.startMs < now + 2 * HOUR && w.endMs > now + HOUR;
      expect(overlaps).toBe(false);
    }
    // 覆盖占用前与占用后两段空闲。
    const starts = person.availableWindows.map((w) => w.startMs).sort((a, b) => a - b);
    expect(starts[0]).toBeLessThanOrEqual(now + HOUR);
    expect(starts[starts.length - 1]).toBeGreaterThanOrEqual(now + 2 * HOUR);
  });

  it('无 reservation 的资源返回单个整段可用窗口', async () => {
    const now = Date.now();
    const svc = makeSvc([personRow()], [deviceRow()], [], []);
    const states = await svc.getUnifiedResourceState();
    const person = states.find((s) => s.id === 'P1')!;
    expect(person.availableWindows).toHaveLength(1);
    // 服务内部以自身调用时刻为 now，允许略晚于测试计时（毫秒级）。
    expect(person.availableWindows[0].startMs).toBeGreaterThanOrEqual(now);
    expect(person.availableWindows[0].endMs).toBeGreaterThan(now);
    expect(person.reservations).toEqual([]);
  });

  it('freshness 判定：FRESH / STALE / UNKNOWN', async () => {
    const now = Date.now();
    const svc = makeSvc(
      [
        personRow({ id: 'P-FRESH', updatedAt: new Date(now) }),
        personRow({ id: 'P-STALE', updatedAt: new Date(now - 6 * 60 * 1000) }),
        personRow({ id: 'P-UNKNOWN', updatedAt: null }),
      ],
      [],
      [],
      [],
    );
    const states = await svc.getUnifiedResourceState();
    const byId = (id: string) => states.find((s) => s.id === id)!;
    expect(byId('P-FRESH').dataQuality).toBe('FRESH');
    expect(byId('P-STALE').dataQuality).toBe('STALE');
    expect(byId('P-UNKNOWN').dataQuality).toBe('UNKNOWN');
    expect(byId('P-FRESH').freshnessMs).toBe(5 * 60 * 1000);
  });

  it('数据过时（STALE/UNKNOWN）不得虚构 available：person/device/station 标 unavailable/offline', async () => {
    const now = Date.now();
    const svc = makeSvc(
      [
        personRow({ id: 'P-OLD', updatedAt: new Date(now - 6 * 60 * 1000) }),
        personRow({ id: 'P-NEW', updatedAt: new Date(now) }),
      ],
      [
        deviceRow({ id: 'D-OLD', deviceId: 'D-OLD', lastTelemetryAt: new Date(now - 6 * 60 * 1000) }),
        deviceRow({ id: 'D-NEW', deviceId: 'D-NEW', lastTelemetryAt: new Date(now) }),
      ],
      [
        stationRow({ id: 'S-OLD', entityId: 'ST-OLD', updatedAt: new Date(now - 6 * 60 * 1000) }),
        stationRow({ id: 'S-NEW', entityId: 'ST-NEW', updatedAt: new Date(now) }),
      ],
      [],
    );
    const states = await svc.getUnifiedResourceState();
    const byId = (id: string) => states.find((s) => s.id === id)!;
    // person：STALE → unavailable，不虚构 available
    expect(byId('P-OLD').status).toBe('UNKNOWN');
    expect(byId('P-NEW').status).toBe('AVAILABLE');
    // device：STALE → offline
    expect(byId('D-OLD').status).toBe('OFFLINE');
    expect(byId('D-NEW').status).toBe('AVAILABLE');
    // station：STALE → UNKNOWN，不虚构 available（station id = entityId；FRESH 且
    // 空间实体 status='active' 经 ADR-007 归一为 AVAILABLE）
    expect(byId('ST-OLD').status).toBe('UNKNOWN');
    expect(byId('ST-NEW').status).toBe('AVAILABLE');
  });


  it('ADR-008：投影实体携带规范身份引用 entityId（person:/device:/station:）', async () => {
    const svc = makeSvc([personRow()], [deviceRow()], [], []);
    const states = await svc.getUnifiedResourceState();
    const person = states.find((s) => s.type === 'person')!;
    const device = states.find((s) => s.type === 'device')!;
    expect(person.entityId).toBe(`person:${person.id}`);
    expect(device.entityId).toBe(`device:${device.id}`);
  });

  it('可选字段：team 来自真实 team_name，currentTask/shift 无背衬列故为 null', async () => {
    const svc = makeSvc([personRow()], [deviceRow()], [], []);
    const states = await svc.getUnifiedResourceState();
    const person = states.find((s) => s.id === 'P1')!;
    const device = states.find((s) => s.id === 'D1')!;
    expect(person.team).toBe('TEAM-A');
    expect(person.currentTask).toBeNull();
    expect(person.shift).toBeNull();
    expect(device.team).toBeNull();
    expect(device.currentTask).toBeNull();
    expect(device.updatedAt).toEqual(expect.any(Number));
  });

  it('projectByType 走统一聚合入口并按类型过滤', async () => {
    const svc = makeSvc([personRow()], [deviceRow()], [stationRow()], []);
    const persons = await svc.projectByType('person');
    expect(persons).toHaveLength(1);
    expect(persons[0].type).toBe('person');
  });
});

describe('P1-T3: ResourceProjection SSOT 收敛（领域字段补齐 + 双源一致性）', () => {
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

  it('device capabilities 与 world-state 统一读列：列有值取真实值；列无值按型号派生并标记 derived', async () => {
    const svc = makeSvc(
      [],
      [
        deviceRow({ id: 'D1', deviceId: 'D1', deviceModel: 'EXO-Pro X1', capabilities: ['crane'] }),
        deviceRow({ id: 'D2', deviceId: 'D2', deviceModel: 'EXO-Pro X1', capabilities: [] }),
        deviceRow({ id: 'D3', deviceId: 'D3', deviceModel: 'EXO-Pro X1' }),
      ],
      [],
    );
    const states = await svc.getUnifiedResourceState();
    const byId = (id: string) => states.find((s) => s.id === id)!;
    // 列有值 → 真实值优先（不再 [deviceModel] 裸串）
    expect(byId('D1').capabilities).toEqual(['crane']);
    expect((byId('D1').derived ?? []).includes('capabilities')).toBe(false);
    // 列空数组 → 型号派生 + derived 标记
    expect(byId('D2').capabilities).toEqual(['exo-lift']);
    expect((byId('D2').derived ?? []).includes('capabilities')).toBe(true);
    // 列缺失（undefined）→ 型号派生 + derived 标记
    expect(byId('D3').capabilities).toEqual(['exo-lift']);
    expect((byId('D3').derived ?? []).includes('capabilities')).toBe(true);
  });

  it('station 投影补 capacity/queue（读列）', async () => {
    const svc = makeSvc(
      [],
      [],
      [stationRow({ id: 'S1', entityId: 'ST-01', capacity: 5, queue: ['t1', 't2'] })],
    );
    const states = await svc.getUnifiedResourceState();
    const station = states.find((s) => s.type === 'station')!;
    expect(station.capacity).toBe(5);
    expect(station.queue).toEqual(['t1', 't2']);
  });

  it('person 投影补 shift/workload/currentTask/certificationExpiry（读列）', async () => {
    const svc = makeSvc(
      [
        personRow({
          id: 'P1',
          shift: 'A班',
          workload: 0.4,
          currentTaskId: 'T1',
          certificationExpiry: [{ name: 'cert-a', expiresAtMs: 1234 }],
        }),
      ],
      [],
      [],
    );
    const states = await svc.getUnifiedResourceState();
    const person = states.find((s) => s.id === 'P1')!;
    expect(person.shift).toBe('A班');
    expect(person.workload).toBe(0.4);
    expect(person.currentTask).toBe('T1');
    expect(person.certificationExpiry).toEqual([{ name: 'cert-a', expiresAtMs: 1234 }]);
  });

  it('device 位置/遥测字段级明细：locationConfidence/locationUpdatedAt/telemetryUpdatedAt', async () => {
    const t = Date.now();
    const svc = makeSvc(
      [],
      [
        deviceRow({
          id: 'D1', deviceId: 'D1',
          locationLat: 500, locationLng: 600, locationConfidence: 0.9,
          locationUpdatedAt: new Date(t), telemetryUpdatedAt: new Date(t),
        }),
        deviceRow({ id: 'D2', deviceId: 'D2' }), // 无位置
      ],
      [],
    );
    const states = await svc.getUnifiedResourceState();
    const byId = (id: string) => states.find((s) => s.id === id)!;
    expect(byId('D1').location.x).toBe(500);
    expect(byId('D1').location.y).toBe(600);
    expect(byId('D1').locationConfidence).toBe(0.9);
    expect(byId('D1').locationUpdatedAt).toBe(t);
    expect(byId('D1').telemetryUpdatedAt).toBe(t);
    // 无位置 → 坐标 UNKNOWN(null) 而非 0，置信度也 null
    expect(byId('D2').location.x).toBeNull();
    expect(byId('D2').location.y).toBeNull();
    expect(byId('D2').locationConfidence).toBeNull();
  });

  it('person/station 坐标缺失 → UNKNOWN(null) 而非 0（未知字段显式 null）', async () => {
    const svc = makeSvc(
      [personRow({ id: 'P1', spatialEntityId: null })],
      [],
      [stationRow({ id: 'S1', entityId: 'ST-01', x: null, y: null })],
    );
    const states = await svc.getUnifiedResourceState();
    const person = states.find((s) => s.id === 'P1')!;
    const station = states.find((s) => s.type === 'station')!;
    expect(person.location.x).toBeNull();
    expect(person.location.y).toBeNull();
    expect(station.location.x).toBeNull();
    expect(station.location.y).toBeNull();
  });

  it('person 无背衬列字段（capacity/queue/locationConfidence/telemetryUpdatedAt）为 null，不虚构', async () => {
    const svc = makeSvc([personRow()], [], []);
    const states = await svc.getUnifiedResourceState();
    const person = states.find((s) => s.id === 'P1')!;
    expect(person.capacity).toBeNull();
    expect(person.queue).toBeNull();
    expect(person.locationConfidence).toBeNull();
    expect(person.telemetryUpdatedAt).toBeNull();
  });
});