/* P1-A（Task 1）：资源时间窗真实交集测试。
 *
 * 覆盖：
 * 1) device maintenance 窗口排除设备候选（负空间）；
 * 2) 缺数据不伪造：无 maintenance 列数据不产生窗口、不排除候选；
 * 3) cert 有效期排除人员（cert_expired）；
 * 4) shift 无时间语义：窗口/eligible 不受 shift 字符串影响（不参与硬交集）；
 * 5) station 容量交集（station_capacity_exceeded）+ station availableWindows 交集（time_conflict）；
 * 6) Task Window ∩ Horizon 交集（earliestStartMs/dueAtMs 边界）。
 * 不依赖真实 DB —— snapshot mock + 真实 EligibilityService/CandidateEngine。
 */
/// <reference types="jest" />
import { CandidateEngineService } from '../candidate-engine.service';
import { EligibilityService } from '../eligibility.service';
import { WorldStateSnapshotService } from '../world-state.service';
import { ResourceProjectionService } from '../resource-projection.service';
import { RouteCostProvider } from '../route-cost.provider';
import { SchedulingPolicyService } from '../scheduling-policy.service';
import { defaultConfig, defaultPolicy } from './scheduler-test-helpers';
import type { WorldStateSnapshot } from '@shared/api.interface';

const MINUTE = 60 * 1000;
const HOUR = 3600_000;

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
      { id: 'p1', name: 'p1', status: 'available', healthStatus: 'normal', skills: ['work'], certifications: [], loadLevel: 0, fatigueLevel: 0, stationId: 'S1', zoneId: 'Z1', x: 0, y: 0 },
    ],
    tasks: [
      {
        id: 't1', title: 't1', taskType: 'work', priority: 'medium', status: 'pending',
        assigneeId: null, deviceId: null, stationId: 'S1', zoneId: 'Z1',
        planStart: null, planEnd: null, progress: 0, predecessorIds: [],
        requiredSkills: ['work'], requiredCertifications: [],
      },
    ],
    devices: [
      { id: 'd1', workerName: null, deviceModel: null, batteryPct: 100, online: true, status: 'online', capabilities: ['exo-lift'], x: 0, y: 0 },
    ],
    stations: [
      { id: 'S1', name: 'S1', x: 0, y: 0, capacity: 1 },
    ],
    forbiddenZones: [],
    lockedAssignments: [],
  });
}

describe('P1-A 时间窗真实交集（CandidateEngine）', () => {
  it('device maintenance 窗口与候选区间重叠 → 设备候选不可派（time_conflict）', async () => {
    const { engine } = makeEngine();
    const now = Date.now();
    const snapshot = baseSnapshot();
    snapshot.tasks[0].requiredDeviceCapabilities = ['exo-lift'];
    const d = snapshot.devices[0] as WorldStateSnapshot['devices'][number] & {
      maintenanceWindows?: Array<{ startMs: number; endMs: number }>;
    };
    // 维护窗口 [now+5min, now+2h]：候选区间 [now+10s, now+30min] 与其重叠。
    d.maintenanceWindows = [{ startMs: now + 5 * MINUTE, endMs: now + 2 * HOUR }];
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(snapshot);
    const res = await engine.evaluateTaskCandidates('t1');
    const c = res.candidates.find((x) => x.personId === 'p1' && x.deviceId === 'd1')!;
    expect(c).toBeDefined();
    expect(c.eligible).toBe(false);
    expect(c.rejectReasons).toContain('time_conflict');
  });

  it('缺数据不伪造：无 maintenance 列数据不产生窗口 → 设备候选正常可派', async () => {
    const { engine } = makeEngine();
    const snapshot = baseSnapshot();
    snapshot.tasks[0].requiredDeviceCapabilities = ['exo-lift'];
    // device 无 maintenanceWindows 字段（列 NULL）→ 不产生维护窗口约束。
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(snapshot);
    const res = await engine.evaluateTaskCandidates('t1');
    const c = res.candidates.find((x) => x.personId === 'p1' && x.deviceId === 'd1')!;
    expect(c.eligible).toBe(true);
    expect(c.rejectReasons).not.toContain('time_conflict');
  });

  it('cert 有效期：requiredCertifications 命中已过期证书 → cert_expired 排除人员', async () => {
    const { engine } = makeEngine();
    const snapshot = baseSnapshot();
    snapshot.tasks[0].requiredCertifications = ['cert-a'];
    snapshot.persons[0].certifications = ['cert-a'];
    snapshot.persons[0].certificationExpiry = [{ name: 'cert-a', expiresAtMs: Date.now() - 1000 }];
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(snapshot);
    const res = await engine.evaluateTaskCandidates('t1');
    const c = res.candidates.find((x) => x.personId === 'p1')!;
    expect(c.eligible).toBe(false);
    expect(c.rejectReasons).toContain('cert_expired');
  });

  it('shift 无时间语义：不同 shift 字符串下时间窗与 eligible 一致（不参与硬交集）', async () => {
    const { engine } = makeEngine();
    const runWith = async (shift?: string) => {
      const snapshot = baseSnapshot();
      if (shift != null) snapshot.persons[0].shift = shift;
      engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(snapshot);
      const res = await engine.evaluateTaskCandidates('t1');
      const c = res.candidates.find((x) => x.personId === 'p1')!;
      return { eligible: c.eligible, reasons: [...c.rejectReasons], timeWindows: res.candidates[0].timeWindows };
    };
    const a = await runWith('A班');
    const b = await runWith('B班');
    const none = await runWith(undefined);
    expect(a.eligible).toBe(true);
    expect(b.eligible).toBe(true);
    expect(none.eligible).toBe(true);
    expect(a.reasons).toEqual(b.reasons);
    expect(a.reasons).toEqual(none.reasons);
    // shift 不改变任务级时间窗（Task Window ∩ Horizon）：窗口结构与宽度一致
    //（两次调用毫秒级时序差容忍——比较宽度而非绝对 startMs/endMs）。
    expect(a.timeWindows.length).toBe(none.timeWindows.length);
    expect(a.timeWindows.length).toBeGreaterThan(0);
    const widthA = a.timeWindows[0].endMs - a.timeWindows[0].startMs;
    const widthNone = none.timeWindows[0].endMs - none.timeWindows[0].startMs;
    expect(widthA).toBe(widthNone);
  });

  it('station 容量交集：capacity 已满 → station_capacity_exceeded 排除候选', async () => {
    const { engine } = makeEngine();
    const snapshot = baseSnapshot();
    snapshot.stations[0].capacity = 0;
    snapshot.tasks[0].candidateStations = ['S1'];
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(snapshot);
    const res = await engine.evaluateTaskCandidates('t1');
    const c = res.candidates.find((x) => x.personId === 'p1')!;
    expect(c.eligible).toBe(false);
    expect(c.rejectReasons).toContain('station_capacity_exceeded');
  });

  it('station availableWindows 不含候选区间 → 工位窗口交集为空（time_conflict）', async () => {
    const { engine } = makeEngine();
    const now = Date.now();
    const snapshot = baseSnapshot();
    // 工位可用窗口 [now+2h, now+4h]：候选区间 [now+10s, now+30min] 不在其内。
    snapshot.stations[0].availableWindows = [
      { startMs: now + 2 * HOUR, endMs: now + 4 * HOUR },
    ];
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(snapshot);
    const res = await engine.evaluateTaskCandidates('t1');
    const c = res.candidates.find((x) => x.personId === 'p1')!;
    expect(c.eligible).toBe(false);
    expect(c.rejectReasons).toContain('time_conflict');
  });

  it('Task Window ∩ Horizon：候选早于 earliestStartMs / 晚于 dueAtMs → 交集为空（time_conflict）', async () => {
    const { engine } = makeEngine();
    const now = Date.now();
    // 候选区间 [now+10s, now+30min]。
    const snapshot = baseSnapshot();
    snapshot.tasks[0].earliestStartMs = now + 2 * HOUR; // 最早开始远晚于候选开始
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(snapshot);
    const res1 = await engine.evaluateTaskCandidates('t1');
    const c1 = res1.candidates.find((x) => x.personId === 'p1')!;
    expect(c1.eligible).toBe(false);
    expect(c1.rejectReasons).toContain('time_conflict');

    const snapshot2 = baseSnapshot();
    snapshot2.tasks[0].dueAtMs = now + 5 * 1000; // 截止已过候选开始
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(snapshot2);
    const res2 = await engine.evaluateTaskCandidates('t1');
    const c2 = res2.candidates.find((x) => x.personId === 'p1')!;
    expect(c2.eligible).toBe(false);
    expect(c2.rejectReasons).toContain('time_conflict');
  });
});
