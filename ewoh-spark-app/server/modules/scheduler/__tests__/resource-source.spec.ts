/* P1-B（Task 2）：ResourceState source 双维度 + safety fail-close 测试。
 *
 * 覆盖：
 * 1) 投影层 source/dataQuality 正交（AUTHORITATIVE+FRESH / DERIVED+FRESH / DERIVED+STALE 等组合）；
 * 2) 候选评估层 safetyCritical 任务 + STALE/UNKNOWN/DERIVED → 拒绝（stale_data /
 *    derived_data_fail_closed）；
 * 3) 非安全任务同状态 → 不受 fail-close 影响（正常评估）。
 * 不依赖真实 DB —— 投影层用内存行；候选层用 snapshot mock。
 */
/// <reference types="jest" />
import { ResourceProjectionService } from '../resource-projection.service';
import {
  ewohPersonnel,
  ewohDevice,
  ewohSpatialEntity,
} from '@server/database/schema';
import type { ReservationResult } from '../resource-reservation.service';
import { CandidateEngineService } from '../candidate-engine.service';
import { EligibilityService } from '../eligibility.service';
import { WorldStateSnapshotService } from '../world-state.service';
import { RouteCostProvider } from '../route-cost.provider';
import { SchedulingPolicyService } from '../scheduling-policy.service';
import { defaultConfig, defaultPolicy } from './scheduler-test-helpers';
import type { WorldStateSnapshot } from '@shared/api.interface';

const MINUTE = 60 * 1000;

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
    capabilities: ['exo-lift'],
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

function makeProjectionSvc(
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

describe('P1-B 投影层：source 与 dataQuality 正交', () => {
  it('device capabilities 列有值 + 数据新鲜 → source=AUTHORITATIVE + dataQuality=FRESH', async () => {
    const svc = makeProjectionSvc([], [deviceRow({ capabilities: ['crane'] })], []);
    const states = await svc.getUnifiedResourceState();
    const d = states.find((s) => s.id === 'D1')!;
    expect(d.dataQuality).toBe('FRESH');
    expect(d.source).toBe('AUTHORITATIVE');
    expect((d.derived ?? []).includes('capabilities')).toBe(false);
  });

  it('device capabilities 型号白名单兜底 + 数据新鲜 → source=DERIVED + dataQuality=FRESH（正交）', async () => {
    const svc = makeProjectionSvc([], [deviceRow({ capabilities: [] })], []);
    const states = await svc.getUnifiedResourceState();
    const d = states.find((s) => s.id === 'D1')!;
    expect(d.dataQuality).toBe('FRESH');
    expect(d.source).toBe('DERIVED');
    expect((d.derived ?? []).includes('capabilities')).toBe(true);
  });

  it('device capabilities 派生 + 数据过时 → source=DERIVED + dataQuality=STALE', async () => {
    const now = Date.now();
    const svc = makeProjectionSvc(
      [],
      [deviceRow({ capabilities: [], lastTelemetryAt: new Date(now - 6 * MINUTE) })],
      [],
    );
    const states = await svc.getUnifiedResourceState();
    const d = states.find((s) => s.id === 'D1')!;
    expect(d.dataQuality).toBe('STALE');
    expect(d.source).toBe('DERIVED');
  });

  it('person 投影无派生兜底字段 → source=AUTHORITATIVE（FRESH 与 STALE 均成立）', async () => {
    const now = Date.now();
    const svc = makeProjectionSvc(
      [
        personRow({ id: 'P-F', updatedAt: new Date(now) }),
        personRow({ id: 'P-S', updatedAt: new Date(now - 6 * MINUTE) }),
      ],
      [],
      [],
    );
    const states = await svc.getUnifiedResourceState();
    const byId = (id: string) => states.find((s) => s.id === id)!;
    expect(byId('P-F').dataQuality).toBe('FRESH');
    expect(byId('P-F').source).toBe('AUTHORITATIVE');
    expect(byId('P-S').dataQuality).toBe('STALE');
    expect(byId('P-S').source).toBe('AUTHORITATIVE');
  });

  it('station 能力来自真实列 entityType → source=AUTHORITATIVE', async () => {
    const svc = makeProjectionSvc([], [], [stationRow()]);
    const states = await svc.getUnifiedResourceState();
    const s = states.find((x) => x.type === 'station')!;
    expect(s.source).toBe('AUTHORITATIVE');
    expect(s.capabilities).toEqual(['station']);
  });
});

/* ===== 候选评估层（safety fail-close）===== */

function makeSnapshot(overrides: Partial<WorldStateSnapshot> = {}): WorldStateSnapshot {
  return {
    snapshotVersion: 'WS-TEST-0001',
    ts: new Date().toISOString(),
    worldVersion: 1,
    entityVersions: {},
    reservations: [],
    safetyBlockedPersonIds: [],
    safetyBlockedDeviceIds: [],
    persons: [],
    tasks: [],
    devices: [],
    stations: [],
    backlog: [],
    events: [],
    routeStatus: [],
    forbiddenZones: [],
    lockedAssignments: [],
    ...overrides,
  };
}

function makeEngine() {
  const worldState = {
    getCurrentWorldState: jest.fn().mockResolvedValue(makeSnapshot()),
    buildSnapshot: jest.fn(),
  };
  const resourceProjection = {
    projectForSnapshot: jest.fn().mockResolvedValue({ persons: [], devices: [], stations: [] }),
  };
  const routeCostProvider = {
    estimate: jest.fn().mockResolvedValue({
      routeId: 'R-1', distanceMeters: 10, etaSeconds: 10, riskLevel: null,
      feasible: true, source: 'euclidean_fallback', riskCost: 0, congestionCost: 0,
      graphVersion: null, calculatedAt: new Date().toISOString(),
      fallbackReason: null, dataQuality: 'FRESH',
    }),
  };
  const policy = {
    getActivePolicy: jest.fn().mockResolvedValue(defaultPolicy()),
    getConfig: jest.fn().mockResolvedValue(defaultConfig()),
  };
  const engine = new CandidateEngineService(
    worldState as unknown as WorldStateSnapshotService,
    resourceProjection as unknown as ResourceProjectionService,
    new EligibilityService(),
    routeCostProvider as unknown as RouteCostProvider,
    policy as unknown as SchedulingPolicyService,
  );
  return { engine, worldState };
}

function baseSnapshot(): WorldStateSnapshot {
  const now = Date.now();
  return makeSnapshot({
    persons: [
      { id: 'p1', name: 'p1', status: 'AVAILABLE', healthStatus: 'normal', skills: ['work'], certifications: ['cert-a'], loadLevel: 0, fatigueLevel: 0, stationId: 'S1', zoneId: 'Z1', x: 0, y: 0 },
    ],
    tasks: [
      {
        id: 't1', title: 't1', taskType: 'work', priority: 'medium', status: 'pending',
        assigneeId: null, deviceId: null, stationId: 'S1', zoneId: 'Z1',
        planStart: null, planEnd: null, progress: 0, predecessorIds: [],
        requiredSkills: ['work'], requiredCertifications: [],
        safetyCritical: true,
      },
    ],
    devices: [
      { id: 'd1', workerName: null, deviceModel: null, batteryPct: 100, online: true, status: 'AVAILABLE', capabilities: [], x: 0, y: 0 },
    ],
    stations: [
      { id: 'S1', name: 'S1', x: 0, y: 0, capacity: 1 },
    ],
    forbiddenZones: [],
    lockedAssignments: [],
  });
}

describe('P1-B 候选评估：safety-critical fail-close', () => {
  it('safetyCritical + person dataQuality=STALE → 候选不可派（stale_data）', async () => {
    const { engine } = makeEngine();
    const snapshot = baseSnapshot();
    (snapshot.persons[0] as { dataQuality?: string }).dataQuality = 'STALE';
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(snapshot);
    const res = await engine.evaluateTaskCandidates('t1');
    const c = res.candidates.find((x) => x.personId === 'p1')!;
    expect(c.eligible).toBe(false);
    expect(c.rejectReasons).toContain('stale_data');
  });

  it('safetyCritical + person dataQuality=UNKNOWN → 候选不可派（stale_data）', async () => {
    const { engine } = makeEngine();
    const snapshot = baseSnapshot();
    (snapshot.persons[0] as { dataQuality?: string }).dataQuality = 'UNKNOWN';
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(snapshot);
    const res = await engine.evaluateTaskCandidates('t1');
    const c = res.candidates.find((x) => x.personId === 'p1')!;
    expect(c.eligible).toBe(false);
    expect(c.rejectReasons).toContain('stale_data');
  });

  it('safetyCritical + device source=DERIVED（能力白名单兜底）→ 候选不可派（derived_data_fail_closed）', async () => {
    const { engine } = makeEngine();
    const snapshot = baseSnapshot();
    snapshot.tasks[0].requiredDeviceCapabilities = ['exo-lift'];
    snapshot.devices[0].capabilities = ['exo-lift'];
    const d = snapshot.devices[0] as WorldStateSnapshot['devices'][number] & {
      source?: 'AUTHORITATIVE' | 'DERIVED';
    };
    d.source = 'DERIVED';
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(snapshot);
    const res = await engine.evaluateTaskCandidates('t1');
    const c = res.candidates.find((x) => x.personId === 'p1' && x.deviceId === 'd1')!;
    expect(c).toBeDefined();
    expect(c.eligible).toBe(false);
    expect(c.rejectReasons).toContain('derived_data_fail_closed');
  });

  it('safetyCritical + person FRESH + device AUTHORITATIVE → 不受 fail-close 拒绝（eligible 保持）', async () => {
    const { engine } = makeEngine();
    const snapshot = baseSnapshot();
    (snapshot.persons[0] as { dataQuality?: string }).dataQuality = 'FRESH';
    const d = snapshot.devices[0] as WorldStateSnapshot['devices'][number] & {
      source?: 'AUTHORITATIVE' | 'DERIVED';
    };
    d.source = 'AUTHORITATIVE';
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(snapshot);
    const res = await engine.evaluateTaskCandidates('t1');
    const c = res.candidates.find((x) => x.personId === 'p1')!;
    expect(c.rejectReasons).not.toContain('stale_data');
    expect(c.rejectReasons).not.toContain('derived_data_fail_closed');
    // 纯手工候选（device=null）无设备维度 → 正常可派。
    const manual = res.candidates.find((x) => x.personId === 'p1' && x.deviceId === null)!;
    expect(manual.eligible).toBe(true);
  });

  it('非安全任务（safetyCritical 缺省 false）+ person STALE → 无 stale_data（fail-close 仅 safetyCritical 生效）', async () => {
    const { engine } = makeEngine();
    const snapshot = baseSnapshot();
    delete snapshot.tasks[0].safetyCritical;
    (snapshot.persons[0] as { dataQuality?: string }).dataQuality = 'STALE';
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(snapshot);
    const res = await engine.evaluateTaskCandidates('t1');
    const c = res.candidates.find((x) => x.personId === 'p1')!;
    expect(c.rejectReasons).not.toContain('stale_data');
    expect(c.rejectReasons).not.toContain('derived_data_fail_closed');
    expect(c.eligible).toBe(true);
  });
});
