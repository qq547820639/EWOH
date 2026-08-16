/* NO-05c（ADR-010）：维护状态事实 → 资源投影 + 资格评估 单元测试。
 *
 * 覆盖：
 * 1) ResourceProjectionService.project()：活跃维护条件（critical→OFFLINE；
 *    非 critical→DEGRADED；不升级 UNKNOWN/OFFLINE）附着到 ResourceState.maintenance；
 *    终态（resolved/closed）与形状不符的行不参与（不伪造事实）。
 * 2) projectForSnapshot()：person/device 状态收敛 + online 收敛；station 附着事实。
 * 3) EligibilityService：维护事实存在即拒派（person_maintenance_blocked /
 *    device_maintenance_blocked / station_maintenance_blocked，fail-closed）。
 * DB 以 table-aware fake 替换（真实 DDL/RLS 由 standalone_034 verify + CI 承担）。
 */
/// <reference types="jest" />
import { ResourceProjectionService } from '../resource-projection.service';
import {
  ewohPersonnel,
  ewohDevice,
  ewohSpatialEntity,
  ewohMaintenanceCondition,
} from '@server/database/schema';
import { EligibilityService } from '../eligibility.service';
import type { ReservationResult } from '../resource-reservation.service';
import { makeEligibilityCtx } from './scheduler-test-helpers';

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

function maintenanceRow(over: Record<string, unknown> = {}) {
  return {
    orgId: 'org-1',
    conditionId: 'mc:1',
    subjectEntityId: 'device:D1',
    subjectKind: 'device',
    conditionType: 'wear',
    severity: 'critical',
    status: 'detected',
    dueAt: null,
    detectedAt: new Date(),
    resolvedAt: null,
    workOrderRef: null,
    evidenceId: null,
    ...over,
  };
}

function makeSvc(opts: {
  personnel?: unknown[];
  devices?: unknown[];
  spatial?: unknown[];
  maintenance?: unknown[];
  reservations?: ReservationResult[];
}) {
  const reservationService = {
    listActive: jest.fn().mockResolvedValue(opts.reservations ?? []),
  };
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn((t: unknown) => {
        if (t === ewohPersonnel) return Promise.resolve(opts.personnel ?? []);
        if (t === ewohDevice) return Promise.resolve(opts.devices ?? []);
        if (t === ewohSpatialEntity) return Promise.resolve(opts.spatial ?? []);
        if (t === ewohMaintenanceCondition) return Promise.resolve(opts.maintenance ?? []);
        return Promise.resolve([]);
      }),
    }),
  };
  return new ResourceProjectionService(db as never, reservationService as never);
}

describe('NO-05c：维护状态 → 资源投影（ResourceProjectionService）', () => {
  it('critical 活跃条件 → 设备 OFFLINE 并附着维护事实', async () => {
    const svc = makeSvc({
      devices: [deviceRow()],
      maintenance: [maintenanceRow({ severity: 'critical' })],
    });
    const states = await svc.getUnifiedResourceState();
    const device = states.find((s) => s.id === 'D1')!;
    expect(device.status).toBe('OFFLINE');
    expect(device.maintenance).toHaveLength(1);
    expect(device.maintenance![0]).toEqual(
      expect.objectContaining({ conditionId: 'mc:1', conditionType: 'wear', severity: 'critical' }),
    );
  });

  it('非 critical 活跃条件 → 设备 DEGRADED（不 OFFLINE）', async () => {
    const svc = makeSvc({
      devices: [deviceRow()],
      maintenance: [maintenanceRow({ severity: 'high' })],
    });
    const device = (await svc.getUnifiedResourceState()).find((s) => s.id === 'D1')!;
    expect(device.status).toBe('DEGRADED');
    expect(device.maintenance).toHaveLength(1);
  });

  it('无活跃条件 → maintenance=null 且状态不被改动', async () => {
    const svc = makeSvc({ devices: [deviceRow()] });
    const device = (await svc.getUnifiedResourceState()).find((s) => s.id === 'D1')!;
    expect(device.status).toBe('AVAILABLE');
    expect(device.maintenance).toBeNull();
  });

  it('终态（resolved/closed）与形状不符的行不参与投影', async () => {
    const svc = makeSvc({
      devices: [deviceRow()],
      maintenance: [
        maintenanceRow({ severity: 'critical', status: 'resolved' }),
        maintenanceRow({ severity: 'critical', status: 'closed' }),
        { id: 'not-maintenance', name: 'noise' },
      ],
    });
    const device = (await svc.getUnifiedResourceState()).find((s) => s.id === 'D1')!;
    expect(device.status).toBe('AVAILABLE');
    expect(device.maintenance).toBeNull();
  });

  it('person 维护条件 → DEGRADED（status 收敛 + 事实附着）', async () => {
    const svc = makeSvc({
      personnel: [personRow()],
      maintenance: [maintenanceRow({ subjectEntityId: 'person:P1', severity: 'high' })],
    });
    const person = (await svc.getUnifiedResourceState()).find((s) => s.id === 'P1')!;
    expect(person.status).toBe('DEGRADED');
    expect(person.maintenance).toHaveLength(1);
  });

  it('projectForSnapshot：critical 设备 → OFFLINE + online=false；station 附着事实', async () => {
    const svc = makeSvc({
      devices: [deviceRow()],
      spatial: [stationRow()],
      maintenance: [
        maintenanceRow({ severity: 'critical' }),
        maintenanceRow({
          conditionId: 'mc:2',
          subjectEntityId: 'station:ST-01',
          severity: 'medium',
        }),
      ],
    });
    const snap = await svc.projectForSnapshot();
    const device = snap.devices.find((d) => d.id === 'D1')!;
    expect(device.status).toBe('OFFLINE');
    expect(device.online).toBe(false);
    expect(device.maintenance).toHaveLength(1);
    const station = snap.stations.find((s) => s.id === 'ST-01')!;
    expect(station.maintenance).toHaveLength(1);
    expect(station.maintenance![0].conditionId).toBe('mc:2');
  });
});

describe('NO-05c：维护状态 → 资格评估（EligibilityService）', () => {
  const svc = new EligibilityService();

  const basePerson = {
    id: 'p1',
    status: 'AVAILABLE',
    skills: ['work'],
    certifications: [],
    stationId: null,
    loadLevel: 0.1,
    fatigueLevel: 0,
    healthStatus: 'normal',
  };
  const baseTask = {
    id: 't1',
    taskType: 'work',
    requiredSkills: ['work'],
    requiredCertifications: [],
    stationId: 'S1',
    zoneId: null,
    predIds: [],
  };

  it('人员有活跃维护事实 → person_maintenance_blocked（fail-closed）', () => {
    const res = svc.check(
      {
        ...basePerson,
        maintenance: [
          {
            conditionId: 'mc:p',
            conditionType: 'wear',
            severity: 'high',
            status: 'detected',
            dueAt: null,
            overdue: false,
          },
        ],
      },
      baseTask,
      null,
      makeEligibilityCtx(),
    );
    expect(res.eligible).toBe(false);
    expect(res.reasons).toContain('person_maintenance_blocked');
  });

  it('设备有活跃维护事实 → device_maintenance_blocked（fail-closed）', () => {
    const res = svc.check(
      basePerson,
      baseTask,
      {
        id: 'd1',
        batteryPct: 100,
        online: true,
        status: 'AVAILABLE',
        capabilities: [],
        maintenance: [
          {
            conditionId: 'mc:d',
            conditionType: 'calibration_due',
            severity: 'critical',
            status: 'acknowledged',
            dueAt: null,
            overdue: false,
          },
        ],
      },
      makeEligibilityCtx(),
    );
    expect(res.eligible).toBe(false);
    expect(res.reasons).toContain('device_maintenance_blocked');
  });

  it('无维护事实的设备保持原判定（不引入新拒绝）', () => {
    const res = svc.check(
      basePerson,
      baseTask,
      { id: 'd1', batteryPct: 100, online: true, status: 'AVAILABLE', capabilities: [] },
      makeEligibilityCtx(),
    );
    expect(res.eligible).toBe(true);
  });

  it('候选工位维护封锁 → station_maintenance_blocked（fail-closed）', () => {
    const res = svc.check(
      basePerson,
      baseTask,
      null,
      makeEligibilityCtx({
        candidateStationId: 'S1',
        stationMaintenanceBlockedById: new Map([['S1', true]]),
      }),
    );
    expect(res.eligible).toBe(false);
    expect(res.reasons).toContain('station_maintenance_blocked');
  });

  it('未封锁工位不受影响', () => {
    const res = svc.check(
      basePerson,
      baseTask,
      null,
      makeEligibilityCtx({
        candidateStationId: 'S1',
        stationMaintenanceBlockedById: new Map([['S2', true]]),
      }),
    );
    expect(res.eligible).toBe(true);
  });
});
