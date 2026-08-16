/* T03 / P1-2（G7）：Candidate Engine 结构化拒绝测试。
 *
 * 先跑红再改绿：当前无 CandidateEngineService、getTaskCandidates 无 rejectReasons、
 * eligibility 无 health/station 维度。本 spec 断言各场景 rejectReasons 正确、
 * hard 不满足不进 feasible set。
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
  return { engine, worldState, routeCostProvider };
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

describe('T03 / P1-2 CandidateEngineService（结构化拒绝原因）', () => {
  it('evaluateTaskCandidates 返回 eligible/rejectReasons/scoreBreakdown（技能匹配场景）', async () => {
    const { engine } = makeEngine();
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(
      baseSnapshot(),
    );
    const res = await engine.evaluateTaskCandidates('t1');
    expect(res.taskId).toBe('t1');
    expect(res.candidates.length).toBeGreaterThan(0);
    const c = res.candidates[0];
    // 旧字段兼容（eligible/reasons）+ 新字段（rejectReasons）。
    expect(c).toHaveProperty('eligible');
    expect(Array.isArray(c.rejectReasons)).toBe(true);
    expect(c.rejectReasons).toEqual([]);
  });

  it('技能不匹配 → rejectReasons 含 missing_skill；eligible=false；不进 feasible set', async () => {
    const { engine } = makeEngine();
    const snapshot = baseSnapshot();
    snapshot.tasks[0].requiredSkills = ['welding'];
    snapshot.persons[0].skills = ['work'];
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(snapshot);
    const res = await engine.evaluateTaskCandidates('t1');
    const c = res.candidates.find((x) => x.personId === 'p1')!;
    expect(c).toBeDefined();
    expect(c.eligible).toBe(false);
    expect(c.rejectReasons).toContain('missing_skill');
  });

  it('证书过期 → rejectReasons 含 cert_expired', async () => {
    const { engine } = makeEngine();
    const snapshot = baseSnapshot();
    snapshot.tasks[0].requiredCertifications = ['cert-a'];
    snapshot.persons[0].certificationExpiry = [{ name: 'cert-a', expiresAtMs: Date.now() - 1000 }];
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(snapshot);
    const res = await engine.evaluateTaskCandidates('t1');
    const c = res.candidates.find((x) => x.personId === 'p1')!;
    expect(c.eligible).toBe(false);
    expect(c.rejectReasons).toContain('cert_expired');
  });

  it('设备离线 → rejectReasons 含 device_offline；低电量 → battery_low', async () => {
    const { engine } = makeEngine();
    const offline = baseSnapshot();
    offline.tasks[0].requiredDeviceCapabilities = ['vacuum'];
    offline.devices[0].online = false;
    offline.devices[0].capabilities = ['vacuum'];
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(offline);
    const res1 = await engine.evaluateTaskCandidates('t1');
    const c1 = res1.candidates.find((x) => x.personId === 'p1')!;
    expect(c1.eligible).toBe(false);
    expect(c1.rejectReasons).toContain('device_offline');

    const lowBat = baseSnapshot();
    lowBat.tasks[0].requiredDeviceCapabilities = ['vacuum'];
    lowBat.devices[0].batteryPct = 5;
    lowBat.devices[0].capabilities = ['vacuum'];
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(lowBat);
    const res2 = await engine.evaluateTaskCandidates('t1');
    const c2 = res2.candidates.find((x) => x.personId === 'p1')!;
    expect(c2.eligible).toBe(false);
    expect(c2.rejectReasons).toContain('battery_low');
  });

  it('工位容量不足 → rejectReasons 含 station_capacity_exceeded', async () => {
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

  it('禁入区 → rejectReasons 含 zone_forbidden；时间窗冲突 → time_conflict', async () => {
    const { engine } = makeEngine();
    const zone = baseSnapshot();
    zone.tasks[0].zoneId = 'Z-FORBIDDEN';
    zone.forbiddenZones = [{ zoneId: 'Z-FORBIDDEN', reason: 'restricted' }];
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(zone);
    const res1 = await engine.evaluateTaskCandidates('t1');
    const c1 = res1.candidates.find((x) => x.personId === 'p1')!;
    expect(c1.rejectReasons).toContain('zone_forbidden');

    const conflict = baseSnapshot();
    conflict.reservations = [
      { reservationId: 'r1', resourceId: 'p1', resourceType: 'person', startMs: Date.now() - 5000, endMs: Date.now() + 3600_000 },
    ];
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(conflict);
    const res2 = await engine.evaluateTaskCandidates('t1');
    const c2 = res2.candidates.find((x) => x.personId === 'p1')!;
    expect(c2.rejectReasons).toContain('time_conflict');
  });

  it('健康状态 blocked → rejectReasons 含 health_blocked', async () => {
    const { engine } = makeEngine();
    const snapshot = baseSnapshot();
    snapshot.persons[0].healthStatus = 'blocked';
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(snapshot);
    const res = await engine.evaluateTaskCandidates('t1');
    const c = res.candidates.find((x) => x.personId === 'p1')!;
    expect(c.eligible).toBe(false);
    expect(c.rejectReasons).toContain('health_blocked');
  });

  it('时间窗 end 使用配置 horizonMinutes=120 → end = now + 120min', async () => {
    const { engine } = makeEngine();
    const policy = engine['policyService'] as unknown as { getConfig: jest.Mock };
    policy.getConfig.mockResolvedValue({ ...defaultConfig(), horizonMinutes: 120 });
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(baseSnapshot());
    const before = Date.now();
    const res = await engine.evaluateTaskCandidates('t1');
    const after = Date.now();
    const tw = res.candidates[0].timeWindows[0];
    expect(tw).toBeDefined();
    expect(tw.endMs).toBeGreaterThanOrEqual(before + 120 * 60 * 1000);
    expect(tw.endMs).toBeLessThanOrEqual(after + 120 * 60 * 1000);
  });

  it('时间窗回归：未配置 horizonMinutes → 缺省 end = now + 480min', async () => {
    const { engine } = makeEngine();
    const policy = engine['policyService'] as unknown as { getConfig: jest.Mock };
    const { horizonMinutes: _hm, ...cfgWithoutHorizon } = defaultConfig();
    void _hm;
    policy.getConfig.mockResolvedValue(cfgWithoutHorizon);
    engine['worldStateSnapshotService'].getCurrentWorldState = jest.fn().mockResolvedValue(baseSnapshot());
    const before = Date.now();
    const res = await engine.evaluateTaskCandidates('t1');
    const after = Date.now();
    const tw = res.candidates[0].timeWindows[0];
    expect(tw).toBeDefined();
    expect(tw.endMs).toBeGreaterThanOrEqual(before + 480 * 60 * 1000);
    expect(tw.endMs).toBeLessThanOrEqual(after + 480 * 60 * 1000);
  });

  it('buildCandidatePool 与端点共享语义：hard 不满足的候选 eligible=false + rejectReasons', async () => {
    const { engine } = makeEngine();
    const snapshot = baseSnapshot();
    snapshot.tasks[0].requiredSkills = ['welding'];
    const pool = await engine.buildCandidatePool(snapshot.tasks[0], snapshot, {
      nowMs: Date.now(),
    });
    expect(Array.isArray(pool)).toBe(true);
    const c = pool.find((x) => x.personId === 'p1')!;
    expect(c.eligible).toBe(false);
    expect(c.rejectReasons).toContain('missing_skill');
  });
});
