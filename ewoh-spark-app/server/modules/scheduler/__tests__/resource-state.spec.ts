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
    function makeChain(rows: unknown[]): any {
      const p: any = Promise.resolve(rows);
      p.where = () => p;
      p.orderBy = () => p;
      p.limit = () => p;
      return p;
    }
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn((t: unknown) => {
          if (t === ewohPersonnel) return makeChain(personnelRows);
          if (t === ewohDevice) return makeChain(deviceRows);
          if (t === ewohSpatialEntity) return makeChain(spatialRows);
          return makeChain([]);
        }),
      }),
    };
    return new ResourceProjectionService(db as never, reservationService as never);
  }

  it.each([null, undefined, NaN, Infinity, -Infinity, -1, 101, '80'])(
    'projects invalid device battery %p as unknown in both read models',
    async (batteryPct) => {
      const svc = makeSvc([], [deviceRow({ batteryPct })], [], []);
      const resources = await svc.project();
      const snapshot = await svc.projectForSnapshot();
      expect(resources[0].telemetry.batteryPct).toBeNull();
      expect(snapshot.devices[0].batteryPct).toBeNull();
    },
  );

  it.each([0, 15, 99.5, 100])('preserves measured battery %p', async (batteryPct) => {
    const svc = makeSvc([], [deviceRow({ batteryPct })], [], []);
    expect((await svc.project())[0].telemetry.batteryPct).toBe(batteryPct);
    expect((await svc.projectForSnapshot()).devices[0].batteryPct).toBe(batteryPct);
  });

  it.each([NaN, Infinity, -Infinity, Date.now() + HOUR])(
    'rejects invalid or future resource source timestamp %p',
    async (timestamp) => {
      const updatedAt = new Date(timestamp);
      const svc = makeSvc(
        [personRow({ updatedAt })],
        [deviceRow({ lastTelemetryAt: updatedAt })],
        [stationRow({ updatedAt })],
        [],
      );
      const resources = await svc.project();
      expect(resources.map((resource) => resource.dataQuality)).toEqual([
        'UNKNOWN', 'UNKNOWN', 'UNKNOWN',
      ]);
      expect(resources.map((resource) => resource.status)).toEqual([
        'UNKNOWN', 'OFFLINE', 'UNKNOWN',
      ]);
      const snapshot = await svc.projectForSnapshot();
      expect(snapshot.persons[0]).toMatchObject({ dataQuality: 'UNKNOWN', status: 'UNKNOWN' });
      expect(snapshot.devices[0]).toMatchObject({ dataQuality: 'UNKNOWN', online: false });
    },
  );

  it('preserves the device freshness boundary（含跨系统钟差容忍）', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const svc = makeSvc([], [
        deviceRow({ id: 'fresh', lastTelemetryAt: new Date(now - 60_000) }),
        deviceRow({ id: 'stale', lastTelemetryAt: new Date(now - 60_001) }),
        deviceRow({ id: 'now', lastTelemetryAt: new Date(now) }),
        // 1ms 未来 = DB/宿主机钟差（跨系统比较的正常残余），容忍窗口内 → FRESH
        deviceRow({ id: 'future-small', lastTelemetryAt: new Date(now + 1) }),
        // 远超容忍的未来时间戳 = 时钟确实坏了 → 维持 fail-closed UNKNOWN
        deviceRow({ id: 'future-huge', lastTelemetryAt: new Date(now + 60_000) }),
      ], [], []);
      expect((await svc.project()).map((resource) => resource.dataQuality)).toEqual([
        'FRESH', 'STALE', 'FRESH', 'FRESH', 'UNKNOWN',
      ]);
      expect((await svc.projectForSnapshot()).devices.map((device) => device.dataQuality)).toEqual([
        'FRESH', 'STALE', 'FRESH', 'FRESH', 'UNKNOWN',
      ]);
    } finally {
      clock.mockRestore();
    }
  });

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
        personRow({ id: 'P-STALE', updatedAt: new Date(now - 25 * 60 * 60 * 1000) }),
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
    expect(byId('P-FRESH').freshnessMs).toBe(24 * 60 * 60 * 1000);
  });

  it('阶段二时钟统一：分类 now 取 DB 时钟（clock_timestamp），DB 超前宿主机 27ms 的写后立读仍 FRESH', async () => {
    // ADR-084：sourceTs 与比较 now 同源（都是 DB 时钟）后，写后立读不再受
    // DB/宿主机钟差影响。本用例模拟 DB 时钟超前宿主机 27ms 的真实 Colima 场景。
    const dbClockAtRead = Date.now() + 27; // DB clock_timestamp（VM 可略超前宿主机）
    const justWritten = new Date(dbClockAtRead - 27); // 写侧 now()（DB 钟）刚触碰
    const reservationService = { listActive: jest.fn().mockResolvedValue([]) };
    function makeChain(rows: unknown[]): any {
      const p: any = Promise.resolve(rows);
      p.where = () => p;
      p.orderBy = () => p;
      p.limit = () => p;
      return p;
    }
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn((t: unknown) => {
          if (t === ewohPersonnel) return makeChain([personRow({ updatedAt: justWritten })]);
          if (t === ewohDevice) return makeChain([deviceRow({ lastTelemetryAt: justWritten })]);
          if (t === ewohSpatialEntity) return makeChain([stationRow({ updatedAt: justWritten })]);
          return makeChain([]);
        }),
      }),
      execute: jest.fn().mockResolvedValue([{ ts: dbClockAtRead }]),
    };
    const svc = new ResourceProjectionService(db as never, reservationService as never);
    const resources = await svc.project();
    expect(resources.map((r) => r.dataQuality)).toEqual(['FRESH', 'FRESH', 'FRESH']);
    const snapshot = await svc.projectForSnapshot();
    expect(snapshot.persons[0].dataQuality).toBe('FRESH');
  });

  it('跨系统钟差容忍：写后立读（sourceTs 略超前 now）仍 FRESH，超容忍才 UNKNOWN', async () => {
    // 2026-09-19 实测：DB 容器时钟可比应用宿主机超前几十毫秒。写侧
    // `_updated_at = now()`（DB 钟）后立读（JS Date.now() 比较）时
    // sourceTs > now 属正常跨系统偏差，不得判 UNKNOWN——否则写后立读窗口内
    // 全员资源翻 UNKNOWN → 求解/候选全员 person_unavailable（实测 E2E 失败）。
    const now = Date.now();
    const svc = makeSvc(
      [
        personRow({ id: 'P-SKEW-SMALL', updatedAt: new Date(now + 3_000) }),
        personRow({ id: 'P-SKEW-HUGE', updatedAt: new Date(now + 60_000) }),
      ],
      [],
      [],
      [],
    );
    const states = await svc.getUnifiedResourceState();
    const byId = (id: string) => states.find((s) => s.id === id)!;
    // 容忍窗口内（<5s）：FRESH + AVAILABLE（不得翻 UNKNOWN）
    expect(byId('P-SKEW-SMALL').dataQuality).toBe('FRESH');
    expect(byId('P-SKEW-SMALL').status).toBe('AVAILABLE');
    // 远超容忍（60s 未来 = 时钟确实坏了）：维持 fail-closed UNKNOWN
    expect(byId('P-SKEW-HUGE').dataQuality).toBe('UNKNOWN');
    expect(byId('P-SKEW-HUGE').status).toBe('UNKNOWN');
  });

  it('数据过时（STALE/UNKNOWN）不得虚构 available：person/device/station 标 unavailable/offline', async () => {
    const now = Date.now();
    const svc = makeSvc(
      [
        personRow({ id: 'P-OLD', updatedAt: new Date(now - 25 * 60 * 60 * 1000) }),
        personRow({ id: 'P-NEW', updatedAt: new Date(now) }),
      ],
      [
        deviceRow({ id: 'D-OLD', deviceId: 'D-OLD', lastTelemetryAt: new Date(now - 6 * 60 * 1000) }),
        deviceRow({ id: 'D-NEW', deviceId: 'D-NEW', lastTelemetryAt: new Date(now) }),
      ],
      [
        stationRow({ id: 'S-OLD', entityId: 'ST-OLD', updatedAt: new Date(now - 25 * 60 * 60 * 1000) }),
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
    function makeChain(rows: unknown[]): any {
      const p: any = Promise.resolve(rows);
      p.where = () => p;
      p.orderBy = () => p;
      p.limit = () => p;
      return p;
    }
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn((t: unknown) => {
          if (t === ewohPersonnel) return makeChain(personnelRows);
          if (t === ewohDevice) return makeChain(deviceRows);
          if (t === ewohSpatialEntity) return makeChain(spatialRows);
          return makeChain([]);
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
